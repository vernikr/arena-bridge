"""HTTP server exposing the bridge API (direct mode: this machine serves the agent)."""

import json
import os
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .audit import audit_dir, read_artifact, tail_audit
from .approvals import decide, list_approvals, settle
from .config import load_config
from .mcp import handle_mcp_payload
from .policy import check_path
from .prompt import build_prompt
from .telegram import answer_callback, edit_message_text, parse_command, send_telegram, start_poller


def make_handler(cfg, engine):
    class Handler(BaseHTTPRequestHandler):
        server_version = "arena-bridge/0.7.17"
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # quiet: we keep our own audit log
            pass

        # -- helpers ---------------------------------------------------
        def _auth_ok(self) -> bool:
            header = self.headers.get("Authorization", "")
            if not header.lower().startswith("bearer "):
                return False
            token = header[7:].strip()
            # re-read the config per request so a rotated token takes effect without a restart
            cfg_now = load_config()
            if cfg_now.get("token") and token == cfg_now.get("token"):
                return True
            # the local token is for the machine owner: approvals and trust
            return bool(cfg_now.get("localToken")) and token == cfg_now.get("localToken")

        def _send(self, status, payload, content_type="application/json; charset=utf-8", raw=False):
            body = payload if raw else json.dumps(payload, indent=2, default=str).encode()
            if isinstance(body, str):
                body = body.encode()
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if body:
                self.wfile.write(body)

        def _read_body(self) -> bytes:
            length = int(self.headers.get("Content-Length") or 0)
            limit = int(cfg.get("maxUploadBytes", 16 * 1024 * 1024))
            if length > limit:
                raise ValueError("request body too large")
            return self.rfile.read(length) if length else b""

        def _json_body(self) -> dict:
            raw = self._read_body()
            if not raw:
                return {}
            try:
                return json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError as e:
                raise ValueError(f"invalid JSON body: {e}")

        def _route(self):
            parsed = urllib.parse.urlparse(self.path)
            return parsed.path, urllib.parse.parse_qs(parsed.query)

        def _query_one(self, query, key):
            values = query.get(key) or []
            return values[0] if values else None

        # -- verbs ------------------------------------------------------
        def do_GET(self):
            path, query = self._route()
            if path == "/health":
                return self._send(200, {"ok": True, "mode": "direct", "device": cfg.get("device"), "version": "0.7.17"})
            if not self._auth_ok():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            if path == "/tools":
                return self._send(200, {"ok": True, "tools": engine.mcp_tools()})
            if path == "/prompt":
                base = self._query_one(query, "base")
                return self._send(200, build_prompt(cfg, base_url=base, tools=engine.catalog()), content_type="text/plain; charset=utf-8")
            if path == "/config":
                return self._send(
                    200,
                    {
                        "ok": True,
                        "device": cfg.get("device"),
                        "roots": cfg.get("roots"),
                        "protected_count": len(cfg.get("protected") or []),
                        "requireApproval": cfg.get("requireApproval"),
                        "allowShell": cfg.get("allowShell"),
                        "approvalWaitSec": cfg.get("approvalWaitSec"),
                        "maxOutputBytes": cfg.get("maxOutputBytes"),
                        "telegram": {
                            "enabled": bool((cfg.get("telegram") or {}).get("enabled")),
                            "chat_ids": (cfg.get("telegram") or {}).get("chatIds") or [],
                        },
                    },
                )
            if path == "/audit":
                limit = min(200, int(self._query_one(query, "limit") or 30))
                return self._send(200, {"ok": True, "entries": tail_audit(limit), "artifacts_dir": str(audit_dir())})
            if path == "/audit/artifact":
                entry = self._query_one(query, "entry")
                name = self._query_one(query, "file")
                if not entry or not name:
                    return self._send(400, {"ok": False, "error": "entry and file query parameters are required"})
                art = read_artifact(entry, name)
                if not art:
                    return self._send(404, {"ok": False, "error": "artifact_not_found"})
                lower = art["file"].lower()
                ctype = (
                    "image/png"
                    if lower.endswith(".png")
                    else "image/jpeg"
                    if lower.endswith((".jpg", ".jpeg"))
                    else "application/json; charset=utf-8"
                    if lower.endswith(".json")
                    else "text/plain; charset=utf-8"
                )
                return self._send(200, art["data"], content_type=ctype)
            if path == "/approvals":
                return self._send(200, {"ok": True, "approvals": list_approvals()})
            if path == "/files":
                return self._files(query, "GET")
            return self._send(404, {"ok": False, "error": f"no route for GET {path}"})

        def do_POST(self):
            path, query = self._route()
            if path == "/health":
                return self._send(200, {"ok": True, "mode": "direct"})
            if not self._auth_ok():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            try:
                if path == "/exec":
                    body = self._json_body()
                    result = engine.call(
                        "bash",
                        {
                            "command": body.get("command"),
                            "cwd": body.get("cwd"),
                            "timeout_sec": body.get("timeout_sec"),
                            "env": body.get("env"),
                        },
                    )
                    return self._send(200 if result.get("ok") else 400, result)
                if path == "/call":
                    body = self._json_body()
                    if not body.get("tool"):
                        return self._send(400, {"ok": False, "error": "tool is required"})
                    result = engine.call(str(body["tool"]), body.get("args") or {})
                    return self._send(200 if result.get("ok") else 400, result)
                if path == "/mcp":
                    body = self._json_body()
                    responses = handle_mcp_payload(
                        body,
                        {
                            "list_tools": engine.mcp_tools,
                            "call_tool": lambda name, args: engine.call(name, args),
                        },
                    )
                    if not responses:
                        self.send_response(202)
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return
                    payload = responses[0] if len(responses) == 1 else responses
                    return self._send(200, payload)
                if path.startswith("/approvals/"):
                    # approving is a local-only privilege: the agent token must not self-approve
                    header = self.headers.get("Authorization", "")
                    local = header[7:].strip() if header.lower().startswith("bearer ") else None
                    expected = load_config().get("localToken")
                    if not expected or not local or local != expected:
                        return self._send(
                            403,
                            {
                                "ok": False,
                                "error": "forbidden",
                                "reason": 'approvals require the local token — run "arena-bridge approve <id>" on the machine',
                            },
                        )
                    body = self._json_body()
                    decision = "deny" if body.get("decision") == "deny" else "approve"
                    r = decide(path.rsplit("/", 1)[-1], decision, "api")
                    return self._send(200 if r.get("ok") else 400, r)
                if path == "/files":
                    return self._files(query, "PUT")
            except ValueError as e:
                return self._send(400, {"ok": False, "error": str(e)})
            return self._send(404, {"ok": False, "error": f"no route for POST {path}"})

        def do_PUT(self):
            path, query = self._route()
            if not self._auth_ok():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            if path == "/files":
                return self._files(query, "PUT")
            return self._send(404, {"ok": False, "error": f"no route for PUT {path}"})

        def do_DELETE(self):
            path, query = self._route()
            if not self._auth_ok():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            if path == "/files":
                return self._files(query, "DELETE")
            return self._send(404, {"ok": False, "error": f"no route for DELETE {path}"})

        # -- files API --------------------------------------------------
        def _files(self, query, method):
            target = self._query_one(query, "path")
            if not target:
                return self._send(400, {"ok": False, "error": "path query parameter is required"})
            ok, abs_path, err, reason = check_path(target, cfg, engine.base, write=(method != "GET"))
            if not ok:
                return self._send(403, {"ok": False, "error": err, "reason": reason})
            try:
                if method == "GET":
                    data = abs_path.read_bytes()
                    return self._send(200, data, content_type="application/octet-stream", raw=True)
                if method == "PUT":
                    data = self._read_body()
                    abs_path.parent.mkdir(parents=True, exist_ok=True)
                    abs_path.write_bytes(data)
                    return self._send(200, {"ok": True, "path": str(abs_path), "bytes": len(data)})
                if method == "DELETE":
                    if abs_path.is_dir():
                        import shutil

                        shutil.rmtree(abs_path, ignore_errors=True)
                    elif abs_path.exists():
                        abs_path.unlink()
                    return self._send(200, {"ok": True, "path": str(abs_path), "deleted": True})
            except Exception as e:
                return self._send(400, {"ok": False, "error": str(e)})
            return self._send(405, {"ok": False, "error": "method not allowed"})

    return Handler


def _telegram_message_handler(cfg):
    def handle(item):
        cmd = parse_command(item.get("text"))
        if not cmd:
            return
        chat_id = item.get("chat_id")

        def say(text):
            send_telegram(cfg, text=text, chat_id=chat_id)

        if cmd["cmd"] in ("approve", "deny") and cmd["args"]:
            res = decide(cmd["args"], "approve" if cmd["cmd"] == "approve" else "deny", "telegram")
            say(
                "{} {}".format("Approved" if cmd["cmd"] == "approve" else "Denied", cmd["args"])
                if res.get("ok")
                else "Cannot {}: {}".format(cmd["cmd"], res.get("error"))
            )
            return
        if cmd["cmd"] == "status":
            pending = len([a for a in list_approvals() if a.get("status") == "pending"])
            say("arena-bridge on {}\nPending approvals: {}".format(cfg.get("device"), pending))
            return
        if cmd["cmd"] == "help":
            say("Commands: /approve <id>, /deny <id>, /status")

    return handle


def _telegram_callback_handler(cfg):
    def handle(item):
        data = str(item.get("data") or "")
        action, _, approval_id = data.partition(":")
        if action not in ("approve", "approve3h", "deny") or not approval_id:
            answer_callback(cfg, item.get("callback_id"), "Unknown action")
            return
        trust_sec = 3 * 3600 if action == "approve3h" else 0
        res = settle(approval_id, "deny" if action == "deny" else "approve", "telegram", trust_sec)
        tool = (res.get("approval") or {}).get("tool") or "the tool"
        if not res.get("ok"):
            text = "Cannot {}: {}".format(action, res.get("error") or "unknown error")
        elif action == "deny":
            text = "Denied {}".format(approval_id)
        elif trust_sec:
            text = "Approved {} — {} is trusted for the next 3 hours".format(approval_id, tool)
        else:
            text = "Approved {}".format(approval_id)
        answer_callback(cfg, item.get("callback_id"), "Done" if res.get("ok") else "Error")
        edit_message_text(cfg, item.get("chat_id"), item.get("message_id"), text)

    return handle


def serve(cfg, engine):
    handler = make_handler(cfg, engine)
    server = ThreadingHTTPServer((cfg.get("host", "127.0.0.1"), int(cfg.get("port", 8787))), handler)
    server.daemon_threads = True
    poller = start_poller(cfg, _telegram_message_handler(cfg), _telegram_callback_handler(cfg))
    if poller:
        server.telegram_poller = poller
    return server
