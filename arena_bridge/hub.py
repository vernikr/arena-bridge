"""Hub (relay) server: many devices connect out to it, the cloud agent talks to it."""

import json
import threading
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .approvals import decide, list_approvals
from .config import load_config
from .engine import TOOLS
from .mcp import handle_mcp_payload
from .policy import check_path
from .prompt import build_prompt


class HubState:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.devices = {}   # name -> last_seen timestamp
        self.queues = {}    # name -> [job]
        self.jobs = {}      # id -> {event, result_box, timer}
        self.lock = threading.Lock()

    def device_tokens(self):
        tokens = []
        if self.cfg.get("deviceToken"):
            tokens.append(self.cfg["deviceToken"])
        tokens.extend((self.cfg.get("deviceTokens") or {}).values())
        return tokens

    def is_device(self, header: str) -> bool:
        if not header.lower().startswith("bearer "):
            return False
        token = header[7:].strip()
        return any(token == t for t in self.device_tokens())

    def touch(self, name: str):
        import time

        with self.lock:
            self.devices[name] = time.time()

    def online(self, name: str) -> bool:
        import time

        last = self.devices.get(name)
        return bool(last) and (time.time() - last) < 60

    def dispatch(self, device, tool, args, timeout_sec=120):
        job_id = str(uuid.uuid4())
        event = threading.Event()
        box = {}
        timer = threading.Timer(
            timeout_sec + 15,
            lambda: (box.setdefault("result", {"ok": False, "error": "TIMEOUT", "reason": f'device "{device}" did not answer in time'}), event.set()),
        )
        timer.daemon = True
        with self.lock:
            self.jobs[job_id] = {"event": event, "box": box, "timer": timer}
            self.queues.setdefault(device, []).append({"id": job_id, "tool": tool, "args": args})
        timer.start()
        event.wait(timeout_sec + 20)
        with self.lock:
            job = self.jobs.pop(job_id, None)
        if job:
            job["timer"].cancel()
        return box.get("result") or {"ok": False, "error": "TIMEOUT", "reason": "no result"}

    def next_job(self, device):
        with self.lock:
            queue = self.queues.get(device) or []
            if not queue:
                return None
            return queue.pop(0)

    def complete(self, job_id, result):
        with self.lock:
            job = self.jobs.get(job_id)
        if not job:
            return False
        job["box"]["result"] = result
        job["event"].set()
        return True


def make_handler(cfg, state: HubState):
    def mcp_tools():
        return [
            {
                "name": t["name"],
                "description": t["description"],
                "inputSchema": t["schema"],
            }
            for t in TOOLS
        ]

    class Handler(BaseHTTPRequestHandler):
        server_version = "arena-bridge/0.7.4"
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            pass

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
            return json.loads(raw.decode()) if raw else {}

        def _route(self):
            parsed = urllib.parse.urlparse(self.path)
            return parsed.path, urllib.parse.parse_qs(parsed.query)

        def _auth_ok(self) -> bool:
            header = self.headers.get("Authorization", "")
            if not header.lower().startswith("bearer "):
                return False
            token = header[7:].strip()
            cfg_now = load_config()
            if cfg_now.get("token") and token == cfg_now.get("token"):
                return True
            # the local token is for the machine owner: approvals and trust
            return bool(cfg_now.get("localToken")) and token == cfg_now.get("localToken")

        def _call_tool(self, tool, args):
            device = (args or {}).get("device") or cfg.get("device")
            if not device:
                return {"ok": False, "error": "no target device specified"}
            if not state.online(device):
                return {"ok": False, "error": "DEVICE_OFFLINE", "reason": f'device "{device}" is not connected'}
            clean = dict(args or {})
            clean.pop("device", None)
            return state.dispatch(device, tool, clean, int((args or {}).get("timeout_sec") or 120))

        # -- verbs ------------------------------------------------------
        def do_GET(self):
            path, query = self._route()
            if path == "/health":
                return self._send(200, {"ok": True, "mode": "hub", "version": "0.7.4", "devices": list(state.devices)})
            if not self._auth_ok():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            if path == "/devices":
                import time

                devices = [
                    {
                        "name": name,
                        "online": state.online(name),
                        "last_seen": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(last)),
                    }
                    for name, last in state.devices.items()
                ]
                return self._send(200, {"ok": True, "devices": devices})
            if path == "/tools":
                return self._send(200, {"ok": True, "tools": mcp_tools()})
            if path == "/prompt":
                base = (query.get("base") or [None])[0]
                return self._send(200, build_prompt(cfg, base_url=base, tools=TOOLS), content_type="text/plain; charset=utf-8")
            if path == "/approvals":
                return self._send(200, {"ok": True, "approvals": list_approvals()})
            if path == "/files":
                return self._files(query, "GET")
            return self._send(404, {"ok": False, "error": f"no route for GET {path}"})

        def do_POST(self):
            path, query = self._route()
            if path == "/health":
                return self._send(200, {"ok": True, "mode": "hub"})

            if path.startswith("/device/"):
                if not state.is_device(self.headers.get("Authorization", "")):
                    return self._send(401, {"ok": False, "error": "unauthorized device"})
                if path == "/device/poll":
                    body = self._json_body()
                    name = str(body.get("device") or cfg.get("device"))
                    state.touch(name)
                    job = state.next_job(name)
                    if not job:
                        self.send_response(204)
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return
                    return self._send(200, job)
                if path == "/device/result":
                    body = self._json_body()
                    ok = state.complete(body.get("id"), body.get("result"))
                    return self._send(200 if ok else 404, {"ok": ok})
                return self._send(404, {"ok": False, "error": f"no device route for {path}"})

            if not self._auth_ok():
                return self._send(401, {"ok": False, "error": "unauthorized"})
            try:
                if path == "/exec":
                    body = self._json_body()
                    result = self._call_tool(
                        "bash",
                        {
                            "device": body.get("device"),
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
                    result = self._call_tool(str(body["tool"]), body.get("args") or {})
                    return self._send(200 if result.get("ok") else 400, result)
                if path == "/mcp":
                    body = self._json_body()
                    responses = handle_mcp_payload(
                        body,
                        {"list_tools": mcp_tools, "call_tool": self._call_tool},
                    )
                    if not responses:
                        self.send_response(202)
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return
                    payload = responses[0] if len(responses) == 1 else responses
                    return self._send(200, payload)
                if path.startswith("/approvals/"):
                    # settling a request is a local-only privilege: the agent token must not self-approve
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

        def _files(self, query, method):
            target = (query.get("path") or [None])[0]
            if not target:
                return self._send(400, {"ok": False, "error": "path query parameter is required"})
            ok, abs_path, err, reason = check_path(target, cfg, None, write=(method != "GET"))
            if not ok:
                return self._send(403, {"ok": False, "error": err, "reason": reason})
            try:
                if method == "GET":
                    return self._send(200, abs_path.read_bytes(), content_type="application/octet-stream", raw=True)
                if method == "PUT":
                    data = self._read_body()
                    abs_path.parent.mkdir(parents=True, exist_ok=True)
                    abs_path.write_bytes(data)
                    return self._send(200, {"ok": True, "path": str(abs_path), "bytes": len(data)})
                if method == "DELETE":
                    import shutil

                    if abs_path.is_dir():
                        shutil.rmtree(abs_path, ignore_errors=True)
                    elif abs_path.exists():
                        abs_path.unlink()
                    return self._send(200, {"ok": True, "path": str(abs_path), "deleted": True})
            except Exception as e:
                return self._send(400, {"ok": False, "error": str(e)})
            return self._send(405, {"ok": False, "error": "method not allowed"})

    return Handler


def serve(cfg):
    state = HubState(cfg)
    handler = make_handler(cfg, state)
    server = ThreadingHTTPServer((cfg.get("host", "127.0.0.1"), int(cfg.get("port", 8787))), handler)
    server.daemon_threads = True
    server.state = state
    return server
