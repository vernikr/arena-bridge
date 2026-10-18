"""Tool catalog and execution engine (standard library only)."""

import base64
import json
import os
import platform
import shutil
import signal
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .approvals import request_approval
from .mac import mac_tools
from .telegram import telegram_tools
from .audit import audit, tail_audit, save_artifact, read_artifact, audit_dir
from .browser import BrowserManager
from .config import config_path, load_config
from .policy import check_path, is_inside, resolve_target
from .trust import trust_allows, trust_state


def _schema(props=None, required=None):
    return {
        "type": "object",
        "properties": props or {},
        "required": required or [],
        "additionalProperties": False,
    }


# --------------------------------------------------------------------------- #
# handlers
# --------------------------------------------------------------------------- #


def _h_bash(args, ctx):
    command = str(args.get("command", ""))
    if not command.strip():
        return {"ok": False, "error": "command is required"}
    if not ctx.cfg.get("allowShell", True):
        return {"ok": False, "error": "shell execution is disabled in the config"}

    base = resolve_target(args["cwd"], ctx.base) if args.get("cwd") else Path(ctx.base)
    ok, abs_path, err, reason = check_path(base, ctx.cfg, ctx.base)
    if not ok:
        return {"ok": False, "error": err, "reason": reason}

    timeout = min(int(args.get("timeout_sec") or ctx.cfg.get("commandTimeoutSec", 120)), 1800)
    env = {**os.environ, **(args.get("env") or {})}
    started = time.time()
    try:
        proc = subprocess.run(
            command,
            shell=True,
            cwd=str(abs_path),
            env=env,
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        return {
            "ok": True,
            "command": command,
            "cwd": str(abs_path),
            "stdout": (e.stdout or b"").decode("utf-8", "replace"),
            "stderr": (e.stderr or b"").decode("utf-8", "replace"),
            "exit_code": -1,
            "timed_out": True,
            "duration_ms": int((time.time() - started) * 1000),
        }
    except Exception as e:  # pragma: no cover - defensive
        return {"ok": False, "error": str(e)}

    cap = int(ctx.cfg.get("maxOutputBytes", 8 * 1024 * 1024))
    stdout = proc.stdout.decode("utf-8", "replace")
    stderr = proc.stderr.decode("utf-8", "replace")
    truncated = False
    if len(stdout) > cap:
        stdout, truncated = stdout[:cap], True
    if len(stderr) > cap:
        stderr, truncated = stderr[:cap], True

    return {
        "ok": True,
        "command": command,
        "cwd": str(abs_path),
        "stdout": stdout,
        "stderr": stderr,
        "exit_code": proc.returncode,
        "truncated": truncated,
        "timed_out": False,
        "duration_ms": int((time.time() - started) * 1000),
    }


def _h_read_file(args, ctx):
    ok, abs_path, err, reason = check_path(args.get("path"), ctx.cfg, ctx.base)
    if not ok:
        return {"ok": False, "error": err, "reason": reason}
    if not abs_path.exists():
        return {"ok": False, "error": f"not found: {abs_path}"}
    if abs_path.is_dir():
        return {"ok": False, "error": f"is a directory: {abs_path}"}
    cap = int(ctx.cfg.get("maxOutputBytes", 8 * 1024 * 1024))
    data = abs_path.read_bytes()
    truncated = len(data) > cap
    return {
        "ok": True,
        "path": str(abs_path),
        "size": len(data),
        "truncated": truncated,
        "content": data[:cap].decode("utf-8", "replace"),
    }


def _h_write_file(args, ctx):
    ok, abs_path, err, reason = check_path(args.get("path"), ctx.cfg, ctx.base, write=True)
    if not ok:
        return {"ok": False, "error": err, "reason": reason}
    content = str(args.get("content", ""))
    if len(content.encode()) > int(ctx.cfg.get("maxUploadBytes", 16 * 1024 * 1024)):
        return {"ok": False, "error": "content exceeds maxUploadBytes"}
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    mode = "ab" if args.get("append") else "wb"
    with open(abs_path, mode) as fh:
        fh.write(content.encode())
    return {
        "ok": True,
        "path": str(abs_path),
        "bytes": len(content.encode()),
        "appended": bool(args.get("append")),
    }


def _h_edit_file(args, ctx):
    ok, abs_path, err, reason = check_path(args.get("path"), ctx.cfg, ctx.base, write=True)
    if not ok:
        return {"ok": False, "error": err, "reason": reason}
    old = str(args.get("old_text", ""))
    if not old:
        return {"ok": False, "error": "old_text is required"}
    if not abs_path.exists():
        return {"ok": False, "error": f"not found: {abs_path}"}
    text = abs_path.read_text(errors="replace")
    count = text.count(old)
    if count == 0:
        return {"ok": False, "error": "old_text not found in file"}
    if count > 1 and not args.get("replace_all"):
        return {"ok": False, "error": f"old_text appears {count} times, pass replace_all=true"}
    new = str(args.get("new_text", ""))
    text = text.replace(old, new) if args.get("replace_all") else text.replace(old, new, 1)
    abs_path.write_text(text)
    return {"ok": True, "path": str(abs_path), "replacements": count if args.get("replace_all") else 1}


def _h_list_dir(args, ctx):
    ok, abs_path, err, reason = check_path(args.get("path"), ctx.cfg, ctx.base)
    if not ok:
        return {"ok": False, "error": err, "reason": reason}
    if not abs_path.exists():
        return {"ok": False, "error": f"not found: {abs_path}"}
    if not abs_path.is_dir():
        return {"ok": False, "error": f"not a directory: {abs_path}"}

    max_entries = min(int(args.get("max_entries") or 500), 20000)
    depth = max(0, min(int(args.get("depth") if args.get("depth") is not None else (3 if args.get("recursive") else 0)), 8))
    show_hidden = args.get("include_hidden") is not False
    skip = {"node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", ".next"}
    entries = []
    errors = []

    def walk(d: Path, level: int):
        if len(entries) >= max_entries or level > depth:
            return
        try:
            items = sorted(d.iterdir(), key=lambda p: p.name)
        except OSError as exc:
            errors.append({"path": str(d), "error": getattr(exc, "strerror", str(exc))})
            return
        for it in items:
            if len(entries) >= max_entries:
                return
            if not show_hidden and it.name.startswith("."):
                continue
            size = None
            mtime = None
            try:
                # lstat never follows symlinks: a dead link cannot block the listing
                st = it.lstat()
                size = st.st_size
                mtime = st.st_mtime * 1000
                is_dir = it.is_dir() and not it.is_symlink()
                kind = "dir" if is_dir else "symlink" if it.is_symlink() else "file"
            except OSError as exc:
                errors.append({"path": str(it), "error": getattr(exc, "strerror", str(exc))})
                continue
            entries.append(
                {
                    "path": str(it),
                    "name": it.name,
                    "type": kind,
                    "size": size,
                    "mtime": mtime,
                    "depth": level,
                }
            )
            if kind == "dir" and level < depth and it.name not in skip:
                walk(it, level + 1)

    walk(abs_path, 0)
    return {
        "ok": True,
        "path": str(abs_path),
        "count": len(entries),
        "depth": depth,
        "truncated": len(entries) >= max_entries,
        "errors": errors or None,
        "entries": entries,
    }


def _h_search_files(args, ctx):
    ok, abs_path, err, reason = check_path(args.get("path"), ctx.cfg, ctx.base)
    if not ok:
        return {"ok": False, "error": err, "reason": reason}
    query = str(args.get("query", ""))
    if not query:
        return {"ok": False, "error": "query is required"}
    max_results = min(int(args.get("max_results") or 100), 5000)
    max_file = int(args.get("max_file_bytes") or 2 * 1024 * 1024)
    skip = {"node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", ".next"}

    if args.get("regex"):
        import re

        try:
            pattern = re.compile(query)
        except re.error as e:
            return {"ok": False, "error": f"invalid regex: {e}"}
        matcher = lambda s: pattern.search(s) is not None  # noqa: E731
    else:
        needle = query.lower()
        matcher = lambda s: needle in s.lower()  # noqa: E731

    results = []

    def walk(d: Path):
        if len(results) >= max_results:
            return
        try:
            items = list(d.iterdir())
        except Exception:
            return
        for it in items:
            if len(results) >= max_results:
                return
            if it.is_dir():
                if it.name not in skip:
                    walk(it)
                continue
            if not it.is_file():
                continue
            try:
                if it.stat().st_size > max_file:
                    continue
                text = it.read_text(errors="replace")
            except Exception:
                continue
            for i, line in enumerate(text.splitlines()):
                if matcher(line):
                    results.append({"path": str(it), "line": i + 1, "text": line[:500]})
                    if len(results) >= max_results:
                        return

    walk(abs_path)
    return {"ok": True, "path": str(abs_path), "count": len(results), "results": results}


def _h_delete_path(args, ctx):
    ok, abs_path, err, reason = check_path(args.get("path"), ctx.cfg, ctx.base, write=True)
    if not ok:
        return {"ok": False, "error": err, "reason": reason}
    if is_inside(abs_path, Path(ctx.base)) and abs_path == Path(ctx.base):
        return {"ok": False, "error": "refusing to delete the working root"}
    if abs_path.is_dir():
        shutil.rmtree(abs_path, ignore_errors=True)
    elif abs_path.exists():
        abs_path.unlink()
    return {"ok": True, "path": str(abs_path), "deleted": True}


def _h_file_get(args, ctx):
    ok, abs_path, err, reason = check_path(args.get("path"), ctx.cfg, ctx.base)
    if not ok:
        return {"ok": False, "error": err, "reason": reason}
    if not abs_path.is_file():
        return {"ok": False, "error": f"not a file: {abs_path}"}
    if abs_path.stat().st_size > int(ctx.cfg.get("maxUploadBytes", 16 * 1024 * 1024)):
        return {"ok": False, "error": "file too large"}
    data = abs_path.read_bytes()
    return {
        "ok": True,
        "path": str(abs_path),
        "size": len(data),
        "data_base64": base64.b64encode(data).decode(),
    }


def _h_file_put(args, ctx):
    ok, abs_path, err, reason = check_path(args.get("path"), ctx.cfg, ctx.base, write=True)
    if not ok:
        return {"ok": False, "error": err, "reason": reason}
    data = base64.b64decode(str(args.get("data_base64", "")))
    if len(data) > int(ctx.cfg.get("maxUploadBytes", 16 * 1024 * 1024)):
        return {"ok": False, "error": "payload too large"}
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    abs_path.write_bytes(data)
    return {"ok": True, "path": str(abs_path), "bytes": len(data)}


def _h_sysinfo(args, ctx):
    net = {}
    try:
        import socket

        hostname = socket.gethostname()
    except Exception:
        hostname = "unknown"
    try:
        usage = shutil.disk_usage(ctx.base)
        disk = {"total": usage.total, "used": usage.used, "free": usage.free}
    except Exception:
        disk = None
    return {
        "ok": True,
        "hostname": hostname,
        "platform": platform.system(),
        "release": platform.release(),
        "arch": platform.machine(),
        "user": os.environ.get("USER") or os.environ.get("USERNAME") or "unknown",
        "home": str(Path.home()),
        "cwd": str(ctx.base),
        "uptime_sec": int(time.time() - os.stat("/proc/uptime").st_mtime) if os.path.exists("/proc/uptime") else None,
        "cpu_count": os.cpu_count(),
        "disk": disk,
        "python": platform.python_version(),
        "network": net,
    }


def _h_start_process(args, ctx):
    command = str(args.get("command", ""))
    if not command.strip():
        return {"ok": False, "error": "command is required"}
    base = resolve_target(args["cwd"], ctx.base) if args.get("cwd") else Path(ctx.base)
    ok, abs_path, err, reason = check_path(base, ctx.cfg, ctx.base)
    if not ok:
        return {"ok": False, "error": err, "reason": reason}

    proc = subprocess.Popen(
        command,
        shell=True,
        cwd=str(abs_path),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    session_id = f"proc_{int(time.time())}_{os.getpid()}"
    session = {
        "id": session_id,
        "proc": proc,
        "command": command,
        "cwd": str(abs_path),
        "out": [],
        "err": [],
        "threads": [],
        "startedAt": time.time(),
        "lock": threading.Lock(),
    }

    def drain(stream, key):
        for line in iter(stream.readline, ""):
            with session["lock"]:
                session[key].append(line)
            if len(session[key]) > 5000:
                with session["lock"]:
                    del session[key][:1000]

    for stream, key in ((proc.stdout, "out"), (proc.stderr, "err")):
        t = threading.Thread(target=drain, args=(stream, key), daemon=True)
        t.start()
        session["threads"].append(t)

    ctx.sessions[session_id] = session
    return {"ok": True, "session_id": session_id, "pid": proc.pid, "command": command, "cwd": str(abs_path)}


def _h_read_process_output(args, ctx):
    session = ctx.sessions.get(str(args.get("session_id", "")))
    if not session:
        return {"ok": False, "error": f"unknown session: {args.get('session_id')}"}
    wait = min(int(args.get("timeout_sec") or 0), 120)
    deadline = time.time() + wait
    while time.time() < deadline and session["proc"].poll() is None:
        time.sleep(0.2)
    if session["proc"].poll() is not None:
        # the process is gone: let the reader threads flush the remaining output
        for t in session["threads"]:
            t.join(timeout=0.5)
    with session["lock"]:
        stdout = "".join(session["out"])
        stderr = "".join(session["err"])
        if args.get("drain"):
            session["out"].clear()
            session["err"].clear()
    return {
        "ok": True,
        "session_id": session["id"],
        "running": session["proc"].poll() is None,
        "exit_code": session["proc"].poll(),
        "stdout": stdout,
        "stderr": stderr,
        "uptime_sec": int(time.time() - session["startedAt"]),
    }


def _h_write_process(args, ctx):
    session = ctx.sessions.get(str(args.get("session_id", "")))
    if not session:
        return {"ok": False, "error": f"unknown session: {args.get('session_id')}"}
    if session["proc"].poll() is not None:
        return {"ok": False, "error": "process already exited"}
    data = str(args.get("input", ""))
    try:
        session["proc"].stdin.write(data)
        session["proc"].stdin.flush()
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "session_id": session["id"], "written": len(data)}


def _h_kill_process(args, ctx):
    session = ctx.sessions.get(str(args.get("session_id", "")))
    if not session:
        return {"ok": False, "error": f"unknown session: {args.get('session_id')}"}
    sig = signal.SIGKILL if args.get("signal") == "SIGKILL" else signal.SIGTERM
    try:
        session["proc"].send_signal(sig)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "session_id": session["id"], "signal": sig.name, "killed": True}


# --------------------------------------------------------------------------- #
# catalog
# --------------------------------------------------------------------------- #

def _h_audit_log(args, ctx):
    limit = min(200, int(args.get("limit") or 30))
    entries = tail_audit(limit * 4)
    if args.get("tool"):
        entries = [e for e in entries if e.get("tool") == args["tool"]]
    if args.get("since"):
        try:
            since = datetime.fromisoformat(str(args["since"]).replace("Z", "+00:00")).timestamp()
            entries = [
                e
                for e in entries
                if datetime.fromisoformat(str(e.get("ts")).replace("Z", "+00:00")).timestamp() >= since
            ]
        except Exception:
            pass
    entries = entries[-limit:]
    return {"ok": True, "count": len(entries), "entries": entries, "artifacts_dir": str(audit_dir())}


def _h_audit_artifact(args, ctx):
    art = read_artifact(args.get("entry"), args.get("file"))
    if not art:
        return {"ok": False, "error": "artifact_not_found", "hint": "Run audit_log to see the available artifacts."}
    data = art["data"]
    if art["file"].lower().endswith((".png", ".jpg", ".jpeg")):
        return {
            "ok": True,
            "kind": "image",
            "file": art["file"],
            "bytes": len(data),
            "image_base64": base64.b64encode(data).decode("ascii"),
        }
    text = data.decode("utf-8", "replace")
    try:
        content = json.loads(text)
    except ValueError:
        content = text[:200000]
    return {
        "ok": True,
        "kind": "json" if isinstance(content, (dict, list)) else "text",
        "file": art["file"],
        "bytes": len(data),
        "content": content,
    }


TOOLS = [
    {
        "name": "bash",
        "description": "Run a shell command on the remote machine. Returns stdout, stderr and the exit code. Use absolute paths; the working directory defaults to the authorized root. This is a side-effecting operation and may require human approval.",
        "approval": True,
        "schema": _schema(
            {
                "command": {"type": "string", "description": "Shell command to execute"},
                "cwd": {"type": "string", "description": "Working directory (must be inside the authorized roots)"},
                "timeout_sec": {"type": "number", "description": "Timeout in seconds (default 120, max 1800)"},
                "env": {"type": "object", "description": "Extra environment variables"},
            },
            ["command"],
        ),
        "handler": _h_bash,
    },
    {
        "name": "read_file",
        "description": "Read a UTF-8 text file from the remote machine.",
        "approval": False,
        "schema": _schema(
            {
                "path": {"type": "string", "description": "Absolute or root-relative file path"},
                "max_bytes": {"type": "number", "description": "Maximum number of bytes to return"},
            },
            ["path"],
        ),
        "handler": _h_read_file,
    },
    {
        "name": "write_file",
        "description": "Create or overwrite a text file. May require human approval.",
        "approval": True,
        "schema": _schema(
            {
                "path": {"type": "string"},
                "content": {"type": "string"},
                "append": {"type": "boolean"},
            },
            ["path", "content"],
        ),
        "handler": _h_write_file,
    },
    {
        "name": "edit_file",
        "description": "Replace an exact string inside a file (old_text must appear exactly once unless replace_all is true).",
        "approval": True,
        "schema": _schema(
            {
                "path": {"type": "string"},
                "old_text": {"type": "string"},
                "new_text": {"type": "string"},
                "replace_all": {"type": "boolean"},
            },
            ["path", "old_text", "new_text"],
        ),
        "handler": _h_edit_file,
    },
    {
        "name": "list_dir",
        "description": "List the contents of a directory on the remote machine.",
        "approval": False,
        "schema": _schema(
            {
                "path": {"type": "string", "description": 'absolute path, "~" or "~/dir" allowed'},
                "recursive": {"type": "boolean", "description": "walk into subdirectories (default false)"},
                "depth": {"type": "number", "description": "how deep to walk when recursive is set (default 3)"},
                "include_hidden": {"type": "boolean", "description": "include dotfiles (default true)"},
                "max_entries": {"type": "number"},
            },
            ["path"],
        ),
        "handler": _h_list_dir,
    },
    {
        "name": "search_files",
        "description": "Search for a text pattern in files under a directory (read-only).",
        "approval": False,
        "schema": _schema(
            {
                "path": {"type": "string"},
                "query": {"type": "string"},
                "regex": {"type": "boolean"},
                "max_results": {"type": "number"},
                "max_file_bytes": {"type": "number"},
            },
            ["path", "query"],
        ),
        "handler": _h_search_files,
    },
    {
        "name": "delete_path",
        "description": "Delete a file or directory (recursively) on the remote machine. Requires approval.",
        "approval": True,
        "schema": _schema({"path": {"type": "string"}}, ["path"]),
        "handler": _h_delete_path,
    },
    {
        "name": "file_get",
        "description": "Download a binary file as base64 (use for images, archives, binaries).",
        "approval": False,
        "schema": _schema({"path": {"type": "string"}}, ["path"]),
        "handler": _h_file_get,
    },
    {
        "name": "file_put",
        "description": "Upload a binary file (base64 payload). Requires approval.",
        "approval": True,
        "schema": _schema({"path": {"type": "string"}, "data_base64": {"type": "string"}}, ["path", "data_base64"]),
        "handler": _h_file_put,
    },
    {
        "name": "audit_log",
        "description": (
            "Read the detailed log of what happened on this machine: every tool call with its arguments, "
            "outcome and saved artifacts (screenshots, accessibility trees). Read-only."
        ),
        "approval": False,
        "schema": _schema(
            {
                "limit": {"type": "number", "description": "how many entries to return, default 30"},
                "tool": {"type": "string", "description": "only entries of this tool"},
                "since": {"type": "string", "description": "only entries newer than this ISO timestamp"},
            }
        ),
        "handler": _h_audit_log,
    },
    {
        "name": "audit_artifact",
        "description": (
            "Fetch a saved artifact of a logged call: a screenshot (PNG as base64) or an accessibility tree (JSON). "
            "Read-only."
        ),
        "approval": False,
        "schema": _schema(
            {
                "entry": {"type": "string", "description": "entry id from audit_log"},
                "file": {"type": "string", "description": 'artifact file name, e.g. "screen.png" or "ax-tree.json"'},
            },
            ["entry", "file"],
        ),
        "handler": _h_audit_artifact,
    },
    {
        "name": "sysinfo",
        "description": "Read-only information about the remote machine: OS, user, uptime, memory, disks, network interfaces.",
        "approval": False,
        "schema": _schema(),
        "handler": _h_sysinfo,
    },
    {
        "name": "start_process",
        "description": "Start a long-running background process (dev server, watcher, REPL). Returns a session_id to poll with read_process_output.",
        "approval": True,
        "schema": _schema({"command": {"type": "string"}, "cwd": {"type": "string"}}, ["command"]),
        "handler": _h_start_process,
    },
    {
        "name": "read_process_output",
        "description": "Read output of a process started with start_process. Waits up to timeout_sec for new output.",
        "approval": False,
        "schema": _schema(
            {
                "session_id": {"type": "string"},
                "timeout_sec": {"type": "number"},
                "drain": {"type": "boolean"},
            },
            ["session_id"],
        ),
        "handler": _h_read_process_output,
    },
    {
        "name": "write_process",
        "description": "Send input to a running process session (stdin).",
        "approval": False,
        "schema": _schema({"session_id": {"type": "string"}, "input": {"type": "string"}}, ["session_id", "input"]),
        "handler": _h_write_process,
    },
    {
        "name": "kill_process",
        "description": "Terminate a running process session. Requires approval.",
        "approval": True,
        "schema": _schema({"session_id": {"type": "string"}, "signal": {"type": "string"}}, ["session_id"]),
        "handler": _h_kill_process,
    },
]


class _CallContext:
    """Per-call view of the engine that can collect artifacts."""

    def __init__(self, engine, entry_id):
        self._engine = engine
        self.entryId = entry_id
        self.artifacts = []

    def __getattr__(self, name):
        return getattr(self._engine, name)

    def artifact(self, kind, name, data, meta=None):
        saved = save_artifact(self.entryId, kind, name, data, meta or {})
        if saved:
            self.artifacts.append(saved)
        return saved


class Engine:
    def __init__(self, cfg: dict, base=None):
        self.cfg = cfg
        self.base = str(base or (cfg.get("roots") or [os.getcwd()])[0])
        self.sessions = {}
        self.browser = BrowserManager(cfg)

    def catalog(self):
        return TOOLS + self.browser.tools() + mac_tools(self.cfg) + telegram_tools(self.cfg)

    def mcp_tools(self):
        return [
            {
                "name": t["name"],
                "description": t["description"],
                "inputSchema": t["schema"],
            }
            for t in self.catalog()
        ]

    def call(self, name: str, args=None, require_approval=None):
        args = args or {}
        tool = next((t for t in self.catalog() if t["name"] == name), None)
        if not tool:
            return {"ok": False, "error": f"unknown tool: {name}"}
        started = time.time()
        entry_id = "{}-{}-{}".format(
            datetime.now(timezone.utc).isoformat().replace(":", "-").replace(".", "-"),
            str(name).replace("_", "-"),
            uuid.uuid4().hex[:6],
        )
        ctx = _CallContext(self, entry_id)

        need_approval = tool["approval"]
        approval_for = tool.get("approval_for")
        if approval_for:
            need_approval = bool(approval_for(args, self))
        if self.cfg.get("requireApproval", True) is False:
            need_approval = False
        if require_approval is True:
            need_approval = True
        elif require_approval is False:
            need_approval = False

        if need_approval:
            trust = trust_state()
            if trust_allows(trust, name, args, self.cfg):
                if self.cfg.get("audit", True):
                    audit({"id": entry_id, "tool": name, "args": args, "status": "ok", "via": "trust_window"})
                return tool["handler"](args, ctx)
            decision = request_approval(name, args, self.cfg)
            if not decision["approved"]:
                status = decision["rec"].get("status", "denied")
                if self.cfg.get("audit", True):
                    audit({"id": entry_id, "tool": name, "args": args, "status": "approval_denied", "approval_status": status})
                pending = status in ("pending", "timeout", "expired")
                return {
                    "ok": False,
                    "error": "APPROVAL_PENDING" if pending else "APPROVAL_DENIED",
                    "status": status,
                    "pending": pending,
                    "reason": (
                        f'approval wait ended ({status}) for tool "{name}"; this request is closed'
                        if pending
                        else f'human {status} tool "{name}"'
                    ),
                    "approval_id": decision["rec"].get("id"),
                    "hint": (
                        "This approval_id is closed and cannot be approved. Ask the user to open a trust window: "
                        "arena-bridge trust --for 1h. Then retry the call once, or arrange a fresh call for approval while it is waiting."
                        if pending
                        else "The user declined this action. Do not retry it; ask what to do instead."
                    ),
                }

        try:
            res = tool["handler"](args, ctx)
        except Exception as e:  # pragma: no cover - defensive
            if self.cfg.get("audit", True):
                audit({"id": entry_id, "tool": name, "args": args, "status": "exception", "error": str(e)})
            return {"ok": False, "error": str(e)}

        if self.cfg.get("audit", True):
            audit(
                {
                    "id": entry_id,
                    "tool": name,
                    "args": args,
                    "status": "ok" if res.get("ok") else "error",
                    "duration_ms": int((time.time() - started) * 1000),
                    "exit_code": res.get("exit_code"),
                    "error": None if res.get("ok") else res.get("error"),
                    "artifacts": ctx.artifacts or None,
                }
            )
        return res
