"""Chrome control over CDP: the agent's own browser plus attaching to the user's Chrome."""

import base64
import json
import os
import socket
import shutil
import subprocess
import threading
import time
from pathlib import Path

from .cdp import CDPClient, browser_ws_url
from .policy import check_path

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
]

KEYS = {
    "Enter": {"code": "Enter", "key": "Enter", "vk": 13, "text": "\r"},
    "Tab": {"code": "Tab", "key": "Tab", "vk": 9, "text": "\t"},
    "Escape": {"code": "Escape", "key": "Escape", "vk": 27, "text": ""},
    "Backspace": {"code": "Backspace", "key": "Backspace", "vk": 8, "text": ""},
    "Delete": {"code": "Delete", "key": "Delete", "vk": 46, "text": ""},
    "ArrowUp": {"code": "ArrowUp", "key": "ArrowUp", "vk": 38, "text": ""},
    "ArrowDown": {"code": "ArrowDown", "key": "ArrowDown", "vk": 40, "text": ""},
    "ArrowLeft": {"code": "ArrowLeft", "key": "ArrowLeft", "vk": 37, "text": ""},
    "ArrowRight": {"code": "ArrowRight", "key": "ArrowRight", "vk": 39, "text": ""},
    "Space": {"code": "Space", "key": " ", "vk": 32, "text": " "},
}


def _schema(props=None, required=None):
    return {
        "type": "object",
        "properties": props or {},
        "required": required or [],
        "additionalProperties": False,
    }


def profile_dir() -> Path:
    """Where the named agent profiles live (follows ARENA_BRIDGE_HOME when set)."""
    base = os.environ.get("ARENA_BRIDGE_HOME") or str(Path.home() / ".arena-bridge")
    return Path(base) / "chrome-profiles"


def sanitize_profile(name) -> str:
    cleaned = "".join(c if (c.isalnum() or c in "._-") else "-" for c in str(name).strip())
    cleaned = cleaned.strip("-")[:60]
    return cleaned or "default"


def resolve_profile(raw=None, port=9223) -> str:
    """A named profile keeps its logins between agent runs; a path is used as given."""
    if not raw:
        return str(Path.home() / ".arena-bridge" / f"chrome-profile-{port}")
    value = str(raw)
    if value.startswith("/") or value.startswith("~"):
        return str(Path(value.replace("~", str(Path.home()), 1)).resolve())
    return str(profile_dir() / sanitize_profile(value))


def profile_name(raw=None):
    if not raw:
        return None
    value = str(raw)
    if value.startswith("/") or value.startswith("~"):
        return None
    return sanitize_profile(value)


def list_profiles() -> list:
    out = []
    base = profile_dir()
    if not base.exists():
        return out
    for entry in base.iterdir():
        if not entry.is_dir():
            continue
        try:
            files = list(entry.iterdir())
            size = sum(f.stat().st_size for f in files if f.is_file())
            mtime = entry.stat().st_mtime
        except OSError:
            continue
        out.append(
            {
                "name": entry.name,
                "path": str(entry),
                "mtime": mtime * 1000,
                "files": len(files),
                "approx_bytes": size,
            }
        )
    return sorted(out, key=lambda p: p["mtime"], reverse=True)


def profile_pids(profile) -> list:
    """Pids of processes whose command line uses this Chrome user-data-dir."""
    try:
        listing = subprocess.run(["ps", "-Ao", "pid=,command="], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return []
    needle = f"--user-data-dir={profile}"
    out = []
    for line in listing.splitlines():
        if needle not in line:
            continue
        try:
            pid = int(line.strip().split()[0])
        except Exception:
            continue
        if pid != os.getpid():
            out.append(pid)
    return out


def free_port() -> int:
    """A free TCP port on localhost, for a CDP endpoint nobody else owns."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def cleanup_orphan_chromes(sessions=None) -> int:
    """Kill leftover agent-owned headless Chromes (managed profiles only).

    A visible browser the human opened to log in is never touched.
    """
    keep = set()
    for s in sessions or []:
        proc = s.get("proc") if isinstance(s, dict) else None
        if proc is not None and getattr(proc, "pid", None):
            keep.add(proc.pid)
    roots = [str(profile_dir()) + os.sep, str(Path.home() / ".arena-bridge" / "chrome-profile-")]
    try:
        listing = subprocess.run(["ps", "-Ao", "pid=,command="], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return 0
    killed = 0
    for line in listing.splitlines():
        if "--user-data-dir=" not in line or "--headless" not in line:
            continue
        if not any(r in line for r in roots):
            continue
        try:
            pid = int(line.strip().split()[0])
            if pid == os.getpid() or pid in keep:
                continue
            os.kill(pid, 15)
            killed += 1
        except Exception:
            continue
    return killed


def find_chrome():
    env = os.environ.get("CHROME_PATH")
    if env and Path(env).exists():
        return env
    for c in CHROME_CANDIDATES:
        if Path(c).exists():
            return c
    return None


class BrowserManager:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.sessions = {}
        self._counter = 0
        self._lock = threading.Lock()

    # ---------------- sessions ----------------

    def list(self):
        with self._lock:
            sessions = list(self.sessions.values())
        return [
            {
                "session_id": s["id"],
                "managed": s["managed"],
                "headless": s["headless"],
                "port": s["port"],
                "profile": s["profile"],
                "disconnected": bool(s.get("disconnected")),
                "tabs": [
                    {"tab_id": t["targetId"], "title": t["title"], "url": t["url"]} for t in s["tabs"].values()
                ],
                "created_at": s["createdAt"],
            }
            for s in sessions
        ]

    def session(self, session_id=None):
        with self._lock:
            if not session_id:
                s = next(iter(self.sessions.values()), None)
            else:
                s = self.sessions.get(session_id)
        if s is not None and s["cdp"]._closed and not s.get("terminated") and s.get("port"):
            # Chrome may drop an idle DevTools socket while the browser itself
            # is fine. Revive the session (same id, same tabs) instead of
            # failing every later call with "no browser session".
            self._reconnect(s)
        return s

    def _reconnect(self, session) -> bool:
        try:
            ws_url = browser_ws_url(session["port"])
            session["cdp"] = CDPClient(ws_url).connect()
            res = session["cdp"].send("Target.getTargets")
            alive = set()
            for t in res.get("targetInfos", []):
                if t.get("type") != "page":
                    continue
                alive.add(t["targetId"])
                tab = self._attach_target(session, t["targetId"])
                tab["title"] = t.get("title", "")
                tab["url"] = t.get("url", "")
            for target_id in list(session["tabs"].keys()):
                if target_id not in alive:
                    session["tabs"].pop(target_id, None)
            session["disconnected"] = False
            session["reconnects"] = session.get("reconnects", 0) + 1
            return True
        except Exception:
            session["disconnected"] = True
            return False

    def _new_session(self, cdp, port, managed, headless, profile=None, proc=None):
        with self._lock:
            self._counter += 1
            sid = f"chrome_{self._counter}"
            session = {
                "id": sid,
                "cdp": cdp,
                "port": port,
                "managed": managed,
                "headless": headless,
                "profile": profile,
                "proc": proc,
                "tabs": {},
                "observe": {},
                "createdAt": int(time.time() * 1000),
                "disconnected": False,
                "terminated": False,
                "reconnects": 0,
            }
            self.sessions[sid] = session
        return session

    def _attach_target(self, session, target_id):
        res = session["cdp"].send("Target.attachToTarget", {"targetId": target_id, "flatten": True})
        session_id = res.get("sessionId")
        tab = session["tabs"].get(target_id) or {"targetId": target_id, "sessionId": session_id, "title": "", "url": ""}
        tab["sessionId"] = session_id
        session["tabs"][target_id] = tab
        try:
            session["cdp"].send("Page.enable", {}, session_id)
            session["cdp"].send("Runtime.enable", {}, session_id)
        except Exception:
            pass
        return tab

    def _collect_tabs(self, session):
        res = session["cdp"].send("Target.getTargets")
        for t in res.get("targetInfos", []):
            if t.get("type") != "page":
                continue
            existing = session["tabs"].get(t["targetId"])
            if existing:
                existing["title"] = t.get("title", "")
                existing["url"] = t.get("url", "")
            else:
                tab = self._attach_target(session, t["targetId"])
                tab["title"] = t.get("title", "")
                tab["url"] = t.get("url", "")
        return list(session["tabs"].values())

    # ---------------- launch / attach ----------------

    def launch(self, args, ctx):
        binary = find_chrome()
        if not binary:
            return {
                "ok": False,
                "error": "Chrome not found",
                "reason": "set CHROME_PATH or install Google Chrome",
            }
        headless = args.get("headless", True) is not False
        port = int(args.get("port") or 0) or free_port()
        profile = resolve_profile(args.get("profile"), port)

        # One profile = one Chrome (see the Node implementation for rationale).
        with self._lock:
            sessions = list(self.sessions.values())
        for s in sessions:
            if s.get("profile") == profile:
                return {"ok": False, "error": "profile_busy", "profile": profile, "session_id": s["id"],
                        "hint": "This profile is already running in a browser session - reuse it or chrome_stop it first."}
            if s.get("port") == port:
                return {"ok": False, "error": "port_busy", "port": port, "session_id": s["id"],
                        "hint": "That CDP port already belongs to another browser session - omit \"port\" to get a free one."}
        external = profile_pids(profile)
        if external:
            return {"ok": False, "error": "profile_busy", "profile": profile, "pids": external,
                    "hint": "A Chrome with this profile is already running (for example a \"browser login\" window). Close it, then retry."}

        Path(profile).mkdir(parents=True, exist_ok=True)

        # As close to a plain Chrome launch as possible (only the CDP port is added).
        chrome_args = [
            f"--remote-debugging-port={port}",
            f"--user-data-dir={profile}",
            "--no-first-run",
            "--no-default-browser-check",
            "--remote-allow-origins=*",
        ]
        if headless:
            chrome_args.append(os.environ.get("ARENA_HEADLESS_FLAG", "--headless=new"))
        else:
            width = int(args.get("width") or 0)
            height = int(args.get("height") or 0)
            if width and height:
                chrome_args.append(f"--window-size={width},{height}")
            if args.get("x") is not None and args.get("y") is not None:
                chrome_args.append(f"--window-position={int(args['x'])},{int(args['y'])}")
        if args.get("url"):
            chrome_args.append(str(args["url"]))

        proc = subprocess.Popen(
            [binary] + chrome_args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )

        ws_url = None
        for _ in range(60):
            time.sleep(0.25)
            try:
                ws_url = browser_ws_url(port)
                break
            except Exception:
                pass
        if not ws_url:
            try:
                proc.terminate()
            except Exception:
                pass
            return {"ok": False, "error": "Chrome did not expose a CDP endpoint in time"}

        cdp = CDPClient(ws_url).connect()
        session = self._new_session(cdp, port, managed=True, headless=headless, profile=profile, proc=proc)
        self._collect_tabs(session)
        return {
            "ok": True,
            "session_id": session["id"],
            "managed": True,
            "headless": headless,
            "port": port,
            "profile": profile,
            "profile_name": profile_name(args.get("profile")),
            "ws_url": ws_url,
            "tabs": [{"tab_id": t["targetId"], "title": t["title"], "url": t["url"]} for t in session["tabs"].values()],
            "note": "This browser belongs to the agent — no local approval needed for actions on it.",
        }

    def _profiles(self, args, ctx):
        sessions = self.list()
        profiles = []
        for p in list_profiles():
            s = next((x for x in sessions if x.get("profile") == p["path"]), None)
            profiles.append({**p, "running": bool(s), "port": s["port"] if s else None,
                             "session_id": s["session_id"] if s else None})
        return {
            "ok": True,
            "count": len(profiles),
            "profiles": profiles,
            "hint": "Ask the user to log in: arena-bridge browser login <name> - then use chrome_launch {\"profile\":\"<name>\"}",
        }

    def attach(self, args, ctx):
        port = int(args.get("port") or 9222)
        try:
            ws_url = browser_ws_url(port)
        except Exception:
            return {
                "ok": False,
                "error": "cannot reach Chrome DevTools",
                "reason": (
                    f"no CDP endpoint on 127.0.0.1:{port}. Launch Chrome with: "
                    f'open -na "Google Chrome" --args --remote-debugging-port={port} --user-data-dir="$HOME/.chrome-debug"'
                ),
            }
        cdp = CDPClient(ws_url).connect()
        session = self._new_session(cdp, port, managed=False, headless=False)
        tabs = self._collect_tabs(session)
        return {
            "ok": True,
            "session_id": session["id"],
            "managed": False,
            "port": port,
            "ws_url": ws_url,
            "tabs": [{"tab_id": t["targetId"], "title": t["title"], "url": t["url"]} for t in tabs],
            "note": (
                "This is the user's own Chrome with their real profile. Every action on it requires a local approval."
            ),
        }

    def stop(self, args):
        with self._lock:
            targets = (
                [self.sessions.get(args["session_id"])] if args.get("session_id") else list(self.sessions.values())
            )
        stopped = []
        for s in targets:
            if not s:
                continue
            if not s["managed"]:
                return {
                    "ok": False,
                    "error": "refusing to stop an attached (user) browser",
                    "session_id": s["id"],
                }
            s["terminated"] = True
            try:
                s["cdp"].close()
            except Exception:
                pass
            try:
                if s.get("proc"):
                    s["proc"].terminate()
            except Exception:
                pass
            with self._lock:
                self.sessions.pop(s["id"], None)
            stopped.append(s["id"])
        return {"ok": True, "stopped": stopped}

    # ---------------- helpers ----------------

    def _tab(self, session, tab_id=None):
        if not tab_id:
            for t in session["tabs"].values():
                return t
            raise ValueError("no open tabs")
        tab = session["tabs"].get(tab_id)
        if not tab:
            raise ValueError(f"unknown tab: {tab_id}")
        return tab

    def _eval(self, session, tab, expression):
        res = session["cdp"].send(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": True,
                "userGesture": True,
            },
            tab["sessionId"],
        )
        if res.get("exceptionDetails"):
            exc = res["exceptionDetails"].get("exception") or {}
            raise RuntimeError(exc.get("description", "page evaluation failed"))
        return (res.get("result") or {}).get("value")

    def _press(self, session, tab, key):
        spec = KEYS.get(
            key,
            {
                "code": key,
                "key": key,
                "vk": ord(key.upper()[0]) if key else 0,
                "text": key if len(key) == 1 else "",
            },
        )
        base = {
            "windowsVirtualKeyCode": spec["vk"],
            "nativeVirtualKeyCode": spec["vk"],
            "key": spec["key"],
            "code": spec["code"],
        }
        session["cdp"].send("Input.dispatchKeyEvent", {"type": "keyDown", **base, "text": spec["text"]}, tab["sessionId"])
        if spec["text"]:
            session["cdp"].send("Input.dispatchKeyEvent", {"type": "char", **base, "text": spec["text"]}, tab["sessionId"])
        session["cdp"].send("Input.dispatchKeyEvent", {"type": "keyUp", **base}, tab["sessionId"])

    # ---------------- tools ----------------

    def tools(self):
        def need_session(args, ctx, managed_only=False):
            session = self.session(args.get("session_id"))
            if not session:
                raise ValueError("no browser session — call chrome_launch or chrome_attach first")
            if managed_only and not session["managed"]:
                raise ValueError("this session is not an agent-owned browser")
            return session

        def requires_approval(args, ctx):
            session = self.session(args.get("session_id"))
            return not (session and session["managed"])

        return [
            {
                "name": "chrome_launch",
                "description": (
                    "Start a Chrome instance owned by the agent (its own profile, no personal data) and attach to it "
                    "over CDP. headless=true runs it without a window; headless=false opens a visible window. "
                    "No local approval is needed for actions on this browser."
                ),
                "approval": False,
                "schema": _schema(
                    {
                        "headless": {"type": "boolean", "description": "true (default) = no window"},
                        "port": {"type": "number", "description": "CDP port (omit to get a free port automatically)"},
                        "url": {"type": "string"},
                        "profile": {
                            "type": "string",
                            "description": "named profile (keeps its logins between runs) or a directory path",
                        },
                        "width": {"type": "number", "description": "window width in pixels (visible window only)"},
                        "height": {"type": "number", "description": "window height in pixels (visible window only)"},
                        "x": {"type": "number", "description": "window left edge"},
                        "y": {"type": "number", "description": "window top edge"},
                    }
                ),
                "handler": lambda args, ctx: self.launch(args, ctx),
            },
            {
                "name": "chrome_profiles",
                "description": (
                    "List the agent's own named browser profiles (each keeps its own logins between runs). "
                    "Launch one with chrome_launch {\"profile\":\"<name>\"}; the user logs into it once with "
                    "'arena-bridge browser login <name>' on their machine."
                ),
                "approval": False,
                "schema": _schema({}),
                "handler": self._profiles,
            },
            {
                "name": "chrome_attach",
                "description": (
                    "Attach to a Chrome instance that is already running with --remote-debugging-port (typically the "
                    "user's own browser on port 9222). Every action on an attached browser requires a local approval."
                ),
                "approval": False,
                "schema": _schema({"port": {"type": "number", "description": "CDP port (default 9222)"}}),
                "handler": lambda args, ctx: self.attach(args, ctx),
            },
            {
                "name": "chrome_tabs",
                "description": "List the open tabs of a browser session (or of all sessions).",
                "approval": False,
                "schema": _schema({"session_id": {"type": "string"}}),
                "handler": lambda args, ctx: (
                    {"ok": True, "sessions": self.list()}
                    if not args.get("session_id")
                    else {
                        "ok": True,
                        "session_id": need_session(args, ctx)["id"],
                        "tabs": [
                            {"tab_id": t["targetId"], "title": t["title"], "url": t["url"]}
                            for t in need_session(args, ctx)["tabs"].values()
                        ],
                    }
                ),
            },
            {
                "name": "chrome_activate",
                "description": (
                    "Make a tab the active one inside its Chrome window (Target.activateTarget). This does NOT move "
                    "the user's mouse cursor and does not steal OS focus — the window is not raised; only the selected "
                    "tab changes. Some pages pause timers/rendering in background tabs, so activating the tab you are "
                    "about to work with makes interactions more reliable."
                ),
                "approval": True,
                "approval_for": requires_approval,
                "schema": _schema({"session_id": {"type": "string"}, "tab_id": {"type": "string"}}),
                "handler": self._activate,
            },
            {
                "name": "chrome_open",
                "description": "Open a URL in the browser (new tab by default).",
                "approval": True,
                "approval_for": requires_approval,
                "schema": _schema(
                    {
                        "url": {"type": "string"},
                        "session_id": {"type": "string"},
                        "new_tab": {"type": "boolean"},
                        "tab_id": {"type": "string"},
                    },
                    ["url"],
                ),
                "handler": self._open,
            },
            {
                "name": "chrome_navigate",
                "description": "Navigate an existing tab to a URL.",
                "approval": True,
                "approval_for": requires_approval,
                "schema": _schema(
                    {"url": {"type": "string"}, "session_id": {"type": "string"}, "tab_id": {"type": "string"}}, ["url"]
                ),
                "handler": self._navigate,
            },
            {
                "name": "chrome_snapshot",
                "description": "Read the page content: mode=text (visible text, default), html (markup) or ax (roles and names).",
                "approval": False,
                "schema": _schema(
                    {
                        "session_id": {"type": "string"},
                        "tab_id": {"type": "string"},
                        "mode": {"type": "string"},
                        "max_chars": {"type": "number"},
                    }
                ),
                "handler": self._snapshot,
            },
            {
                "name": "chrome_observe",
                "description": (
                    "Observe a page for action: visible interactive elements with refs and states "
                    "(pressed/selected/checked), open dialogs, and the current text editor with its content. "
                    "Refs from the result can be clicked with chrome_click {\"ref\": \"...\"}. Read-only."
                ),
                "approval": False,
                "schema": _schema({
                    "session_id": {"type": "string"},
                    "tab_id": {"type": "string"},
                    "limit": {"type": "number", "description": "max elements (default 80, max 300)"},
                    "text_limit": {"type": "number", "description": "max chars of visible page text (default 6000)"},
                }),
                "handler": self._observe_tool,
            },
            {
                "name": "chrome_fill_editor",
                "description": (
                    "Find the visible text editor on the page (textarea, contenteditable or textbox), "
                    "optionally clear it, type text with real input events and read the value back. "
                    "No CSS selector needed."
                ),
                "approval": True,
                "approval_for": requires_approval,
                "schema": _schema({
                    "session_id": {"type": "string"},
                    "tab_id": {"type": "string"},
                    "text": {"type": "string"},
                    "clear": {"type": "boolean", "description": "clear the editor first (default true)"},
                    "submit": {"type": "boolean", "description": "press Enter afterwards"},
                    "expect": {"type": "object", "description": "condition to wait for afterwards (see chrome_wait_for)"},
                }, ["text"]),
                "handler": self._fill_editor_tool,
            },
            {
                "name": "chrome_wait_for",
                "description": (
                    "Wait until a page condition holds: {type: text_present|text_absent|element_present|"
                    "element_absent|dialog_closed|composer_empty, text, role, name}. Returns verified=true "
                    "when it does, verified=false after the timeout. Read-only."
                ),
                "approval": False,
                "schema": _schema({
                    "session_id": {"type": "string"},
                    "tab_id": {"type": "string"},
                    "condition": {"type": "object"},
                    "timeout_sec": {"type": "number", "description": "default 15, max 120"},
                }, ["condition"]),
                "handler": self._wait_for_tool,
            },
            {
                "name": "chrome_click",
                "description": "Click an element — by CSS selector, by visible text, or by index from the ax snapshot.",
                "approval": True,
                "approval_for": requires_approval,
                "schema": _schema(
                    {
                        "session_id": {"type": "string"},
                        "tab_id": {"type": "string"},
                        "selector": {"type": "string"},
                        "text": {"type": "string"},
                        "index": {"type": "number"},
                        "ref": {"type": "string", "description": "element ref from chrome_observe"},
                        "snapshot_id": {"type": "string", "description": "snapshot_id from chrome_observe (detects stale refs)"},
                        "expect": {"type": "object", "description": "condition to wait for afterwards (see chrome_wait_for)"},
                    }
                ),
                "handler": self._click,
            },
            {
                "name": "chrome_type",
                "description": "Type text into an input field (by CSS selector) and optionally submit it with Enter.",
                "approval": True,
                "approval_for": requires_approval,
                "schema": _schema(
                    {
                        "selector": {"type": "string"},
                        "text": {"type": "string"},
                        "session_id": {"type": "string"},
                        "tab_id": {"type": "string"},
                        "submit": {"type": "boolean"},
                        "clear": {"type": "boolean"},
                        "expect": {"type": "object", "description": "condition to wait for afterwards (see chrome_wait_for)"},
                    },
                    ["selector", "text"],
                ),
                "handler": self._type,
            },
            {
                "name": "chrome_press",
                "description": "Press a key in the page (Enter, Tab, Escape, arrows, Backspace, Delete, Space).",
                "approval": True,
                "approval_for": requires_approval,
                "schema": _schema(
                    {"key": {"type": "string"}, "session_id": {"type": "string"}, "tab_id": {"type": "string"}}, ["key"]
                ),
                "handler": self._press_tool,
            },
            {
                "name": "chrome_screenshot",
                "description": (
                    "Capture a PNG screenshot of a tab. With 'path' the image is saved inside the authorized roots; "
                    "otherwise the PNG is returned as base64."
                ),
                "approval": False,
                "schema": _schema(
                    {
                        "path": {"type": "string"},
                        "session_id": {"type": "string"},
                        "tab_id": {"type": "string"},
                        "full_page": {"type": "boolean"},
                    }
                ),
                "handler": self._screenshot,
            },
            {
                "name": "chrome_evaluate",
                "description": "Run arbitrary JavaScript in the page and return the result.",
                "approval": True,
                "approval_for": requires_approval,
                "schema": _schema(
                    {"expression": {"type": "string"}, "session_id": {"type": "string"}, "tab_id": {"type": "string"}},
                    ["expression"],
                ),
                "handler": self._evaluate,
            },
            {
                "name": "chrome_stop",
                "description": "Close a browser session that the agent started (agent-owned browsers only).",
                "approval": False,
                "schema": _schema({"session_id": {"type": "string"}}),
                "handler": lambda args, ctx: self.stop(args),
            },
        ]

    # ---------------- tool handlers ----------------

    def _activate(self, args, ctx):
        session = self.session(args.get("session_id"))
        if not session:
            raise ValueError("no browser session — call chrome_launch or chrome_attach first")
        tab = self._tab(session, args.get("tab_id"))
        session["cdp"].send("Target.activateTarget", {"targetId": tab["targetId"]})
        return {"ok": True, "session_id": session["id"], "tab_id": tab["targetId"]}

    def _open(self, args, ctx):
        session = self.session(args.get("session_id"))
        if not session:
            raise ValueError("no browser session — call chrome_launch or chrome_attach first")
        url = str(args["url"])
        if args.get("tab_id"):
            tab = self._tab(session, args["tab_id"])
            session["cdp"].send("Page.navigate", {"url": url}, tab["sessionId"])
        elif args.get("new_tab") is False:
            tab = self._tab(session)
            session["cdp"].send("Page.navigate", {"url": url}, tab["sessionId"])
        else:
            res = session["cdp"].send("Target.createTarget", {"url": url})
            tab = self._attach_target(session, res["targetId"])
            tab["url"] = url
        time.sleep(0.4)
        return {"ok": True, "session_id": session["id"], "tab_id": tab["targetId"], "url": url}

    def _navigate(self, args, ctx):
        session = self.session(args.get("session_id"))
        if not session:
            raise ValueError("no browser session — call chrome_launch or chrome_attach first")
        tab = self._tab(session, args.get("tab_id"))
        res = session["cdp"].send("Page.navigate", {"url": str(args["url"])}, tab["sessionId"])
        return {"ok": True, "session_id": session["id"], "tab_id": tab["targetId"], "frame_id": res.get("frameId")}

    def _snapshot(self, args, ctx):
        session = self.session(args.get("session_id"))
        if not session:
            raise ValueError("no browser session — call chrome_launch or chrome_attach first")
        tab = self._tab(session, args.get("tab_id"))
        max_chars = min(int(args.get("max_chars") or 20000), 200000)
        mode = args.get("mode") or "text"
        if mode == "ax":
            res = session["cdp"].send("Accessibility.getFullAXTree", {}, tab["sessionId"])
            nodes = []
            for n in res.get("nodes", []):
                role = n.get("role", {}).get("value")
                if not role or role == "none":
                    continue
                state = {}
                for prop in n.get("properties", []):
                    v = (prop.get("value") or {}).get("value")
                    if v is not None and v != "":
                        state[prop.get("name")] = v
                item = {"role": role, "name": n.get("name", {}).get("value", "")}
                if state:
                    item["state"] = state
                nodes.append(item)
            nodes = [n for n in nodes if n["name"]][:500]
            dialogs = [{"name": n["name"]} for n in nodes if n["role"] in ("dialog", "alertdialog")]
            return {"ok": True, "tab_id": tab["targetId"], "mode": mode, "nodes": nodes, "dialogs": dialogs}
        if mode == "html":
            value = self._eval(session, tab, "document.documentElement.outerHTML")
            s = str(value or "")
            return {
                "ok": True,
                "tab_id": tab["targetId"],
                "mode": mode,
                "html": s[:max_chars],
                "truncated": len(s) > max_chars,
            }
        value = self._eval(
            session,
            tab,
            '({title: document.title, url: location.href, text: document.body ? document.body.innerText : ""})',
        )
        value = value or {}
        text = str(value.get("text", ""))
        return {
            "ok": True,
            "tab_id": tab["targetId"],
            "mode": mode,
            "title": value.get("title"),
            "url": value.get("url"),
            "text": text[:max_chars],
            "truncated": len(text) > max_chars,
        }

    def _click(self, args, ctx):
        session = self.session(args.get("session_id"))
        if not session:
            raise ValueError("no browser session — call chrome_launch or chrome_attach first")
        tab = self._tab(session, args.get("tab_id"))
        if args.get("ref"):
            return self._with_expect(session, tab, args, self._click_ref(session, tab, args))
        if args.get("selector"):
            expr = (
                f'(() => {{ const el = document.querySelector({json.dumps(args["selector"])}); '
                "if (!el) return {clicked:false, reason:'not found'}; "
                "el.scrollIntoView({block:'center'}); el.click(); "
                "return {clicked:true, tag: el.tagName, text: (el.innerText||'').slice(0,120)}; })()"
            )
        elif args.get("text"):
            expr = (
                f'(() => {{ const t = {json.dumps(str(args["text"]).lower())}; '
                "const els = [...document.querySelectorAll('a,button,[role=button],input[type=submit],"
                "input[type=button],label,span,div')].filter(e => (e.innerText||e.value||'').trim().toLowerCase() === t); "
                "const el = els[0]; if (!el) return {clicked:false, reason:'no element with that text'}; "
                "el.scrollIntoView({block:'center'}); el.click(); "
                "return {clicked:true, tag: el.tagName, text: (el.innerText||'').slice(0,120)}; })()"
            )
        elif args.get("index") is not None:
            expr = (
                "(() => { const els = [...document.querySelectorAll('a,button,[role=button],input')]"
                ".filter(e => (e.innerText||e.value||'').trim()); "
                f"const el = els[{int(args['index'])}]; "
                "if (!el) return {clicked:false, reason:'index out of range'}; "
                "el.scrollIntoView({block:'center'}); el.click(); "
                "return {clicked:true, tag: el.tagName, text: (el.innerText||'').slice(0,120)}; })()"
            )
        else:
            return {"ok": False, "error": "provide selector, text or index"}
        res = self._eval(session, tab, expr) or {}
        return self._with_expect(session, tab, args, {"ok": bool(res.get("clicked")), "tab_id": tab["targetId"], **res})

    def _type(self, args, ctx):
        session = self.session(args.get("session_id"))
        if not session:
            raise ValueError("no browser session — call chrome_launch or chrome_attach first")
        tab = self._tab(session, args.get("tab_id"))
        clear = "" if args.get("clear") is False else "setter.call(el, '');"
        expr = (
            "(() => { const el = document.querySelector(" + json.dumps(args["selector"]) + "); "
            "if (!el) return {ok:false, reason:'field not found'}; el.focus(); "
            "const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; "
            "const setter = Object.getOwnPropertyDescriptor(proto, 'value').set; "
            + clear
            + "setter.call(el, " + json.dumps(str(args["text"])) + "); "
            "el.dispatchEvent(new Event('input', {bubbles:true})); "
            "el.dispatchEvent(new Event('change', {bubbles:true})); "
            "return {ok:true, value: el.value}; })()"
        )
        res = self._eval(session, tab, expr) or {}
        if not res.get("ok"):
            return {"ok": False, "error": res.get("reason", "typing failed"), "tab_id": tab["targetId"]}
        if args.get("submit"):
            self._press(session, tab, "Enter")
        return self._with_expect(session, tab, args, {"ok": True, "tab_id": tab["targetId"], "value": res.get("value"), "submitted": bool(args.get("submit"))})

    def _press_tool(self, args, ctx):
        session = self.session(args.get("session_id"))
        if not session:
            raise ValueError("no browser session — call chrome_launch or chrome_attach first")
        tab = self._tab(session, args.get("tab_id"))
        self._press(session, tab, str(args["key"]))
        return {"ok": True, "tab_id": tab["targetId"], "key": str(args["key"])}

    def _screenshot(self, args, ctx):
        session = self.session(args.get("session_id"))
        if not session:
            raise ValueError("no browser session — call chrome_launch or chrome_attach first")
        tab = self._tab(session, args.get("tab_id"))
        params = {"format": "png"}
        if args.get("full_page"):
            metrics = session["cdp"].send("Page.getLayoutMetrics", {}, tab["sessionId"])
            size = metrics.get("cssContentSize") or metrics.get("contentSize")
            if size:
                params["clip"] = {"x": 0, "y": 0, "width": size["width"], "height": size["height"], "scale": 1}
                params["captureBeyondViewport"] = True
        res = session["cdp"].send("Page.captureScreenshot", params, tab["sessionId"])
        b64 = str(res.get("data", ""))
        artifact = getattr(ctx, "artifact", None)
        if artifact and b64:
            artifact("screenshot", "page.png", base64.b64decode(b64), {"source": "chrome_screenshot"})
        if args.get("path"):
            ok, abs_path, err, reason = check_path(args["path"], ctx.cfg, ctx.base, write=True)
            if not ok:
                return {"ok": False, "error": err, "reason": reason}
            Path(abs_path).parent.mkdir(parents=True, exist_ok=True)
            Path(abs_path).write_bytes(base64.b64decode(b64))
            return {"ok": True, "tab_id": tab["targetId"], "path": str(abs_path), "bytes": len(base64.b64decode(b64))}
        return {"ok": True, "tab_id": tab["targetId"], "image_base64": b64}

    def _evaluate(self, args, ctx):
        session = self.session(args.get("session_id"))
        if not session:
            raise ValueError("no browser session — call chrome_launch or chrome_attach first")
        tab = self._tab(session, args.get("tab_id"))
        value = self._eval(session, tab, str(args["expression"]))
        return {"ok": True, "tab_id": tab["targetId"], "value": value}

    # ---------------- observe / semantic actions ----------------

    def _observe(self, session, tab, args=None):
        args = args or {}
        limit = max(1, min(int(args.get("limit") or args.get("max_elements") or 80), 300))
        text_limit = max(0, min(int(args.get("text_limit") or 6000), 50000))
        snap_id = "snap_" + format(int(time.time() * 1000), "x") + "_" + format(int(time.time() * 1000000) % 46656, "x")
        expr = (
            "(() => { /*arena-observe*/\n"
            f"      const LIMIT = {limit}, TEXT_LIMIT = {text_limit};\n"
            "      document.querySelectorAll('[data-arena-bridge-ref]').forEach((e) => e.removeAttribute('data-arena-bridge-ref'));\n"
            "      const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);\n"
            "        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };\n"
            "      const name = (e) => (e.getAttribute('aria-label') || e.innerText || e.value ||\n"
            "        e.getAttribute('placeholder') || e.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 160);\n"
            "      const role = (e) => e.getAttribute('role') || ({A:'link',BUTTON:'button',TEXTAREA:'textbox',\n"
            "        SELECT:'combobox',INPUT:(e.type === 'checkbox' ? 'checkbox' : e.type === 'radio' ? 'radio' : 'textbox')}[e.tagName] || e.tagName.toLowerCase());\n"
            "      const state = (e) => { const st = {};\n"
            "        const put = (k, v) => { if (v !== null && v !== undefined) st[k] = (v === 'true' ? true : v === 'false' ? false : v); };\n"
            "        put('pressed', e.getAttribute('aria-pressed')); put('selected', e.getAttribute('aria-selected'));\n"
            "        put('checked', e.getAttribute('aria-checked') !== null ? e.getAttribute('aria-checked') : (typeof e.checked === 'boolean' ? String(e.checked) : null));\n"
            "        put('expanded', e.getAttribute('aria-expanded')); put('disabled', e.disabled || e.getAttribute('aria-disabled'));\n"
            "        st.focused = (document.activeElement === e); return st; };\n"
            "      const SEL = 'a,button,input,textarea,select,summary,[contenteditable],[role=\"button\"],[role=\"textbox\"],[role=\"checkbox\"],[role=\"radio\"],[role=\"tab\"],[role=\"menuitem\"],[role=\"option\"],[role=\"switch\"],[role=\"combobox\"],[role=\"slider\"],[role=\"link\"]';\n"
            "      const els = [...document.querySelectorAll(SEL)].filter(vis);\n"
            "      const elements = els.slice(0, LIMIT).map((e, i) => { const ref = 'el_' + i;\n"
            "        e.setAttribute('data-arena-bridge-ref', ref);\n"
            "        return { ref, role: role(e), name: name(e), tag: e.tagName.toLowerCase(), state: state(e) }; });\n"
            "      const dialogs = [...document.querySelectorAll('dialog[open],[role=\"dialog\"],[role=\"alertdialog\"]')].filter(vis)\n"
            "        .map((d) => ({ text: (d.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 500),\n"
            "          buttons: [...d.querySelectorAll('button,a,[role=\"button\"],input[type=\"button\"],input[type=\"submit\"]')]\n"
            "            .map((b) => name(b)).filter(Boolean).slice(0, 12) }));\n"
            "      const editorSel = 'textarea,[contenteditable=\"true\"],[contenteditable=\"\"],[role=\"textbox\"],input[type=\"text\"],input[type=\"search\"],input[type=\"email\"],input[type=\"url\"],input:not([type])';\n"
            "      const editors = [...document.querySelectorAll(editorSel)].filter(vis);\n"
            "      const ed = document.activeElement && editors.includes(document.activeElement) ? document.activeElement : editors[0];\n"
            "      const composer = ed ? { kind: ed.getAttribute('contenteditable') !== null ? 'contenteditable' : ed.tagName.toLowerCase(),\n"
            "        text: (ed.value !== undefined ? ed.value : (ed.innerText || '')).slice(0, 500), focused: document.activeElement === ed } : null;\n"
            "      return { title: document.title, url: location.href,\n"
            "        text: document.body ? (document.body.innerText || '').slice(0, TEXT_LIMIT) : '',\n"
            "        elements, dialogs, composer, element_total: els.length, truncated: els.length > elements.length };\n"
            "    })()"
        )
        value = self._eval(session, tab, expr) or {}
        refs = {e.get("ref") for e in value.get("elements", [])}
        session.setdefault("observe", {})[tab["targetId"]] = {"id": snap_id, "refs": refs, "url": value.get("url") or tab.get("url")}
        return {"ok": True, "session_id": session["id"], "tab_id": tab["targetId"], "snapshot_id": snap_id, **value}

    def _click_ref(self, session, tab, args):
        snap = (session.get("observe") or {}).get(tab["targetId"])
        ref = str(args.get("ref"))
        if not snap or ref not in snap["refs"] or (args.get("snapshot_id") and args["snapshot_id"] != snap["id"]):
            return {"ok": False, "error": "stale_ref", "ref": args.get("ref"),
                    "reason": "That element ref is not in the latest observation of this tab - call chrome_observe again."}
        expr = (
            "(() => { /*arena-click-ref*/\n"
            f"      const el = document.querySelector('[data-arena-bridge-ref=\"' + {json.dumps(ref)} + '\"]');\n"
            "      if (!el) return { clicked: false, reason: 'element no longer in the page' };\n"
            "      el.scrollIntoView({ block: 'center' }); el.click();\n"
            "      return { clicked: true, tag: el.tagName, text: (el.innerText || el.value || '').slice(0, 120) }; })()"
        )
        res = self._eval(session, tab, expr) or {}
        if not res.get("clicked"):
            return {"ok": False, "error": "stale_ref", "ref": args.get("ref"), "reason": res.get("reason", "click failed")}
        return {"ok": True, "tab_id": tab["targetId"], "ref": args.get("ref"), **res}

    def _fill_editor(self, session, tab, args):
        clear_js = "false" if args.get("clear") is False else "true"
        focus_expr = (
            "(() => { /*arena-fill-focus*/\n"
            "      const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);\n"
            "        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && !e.disabled; };\n"
            "      const sel = 'textarea,[contenteditable=\"true\"],[contenteditable=\"\"],[role=\"textbox\"],input[type=\"text\"],input[type=\"search\"],input[type=\"email\"],input[type=\"url\"],input[type=\"tel\"],input:not([type])';\n"
            "      const eds = [...document.querySelectorAll(sel)].filter(vis);\n"
            "      const ed = (document.activeElement && eds.includes(document.activeElement)) ? document.activeElement : eds[0];\n"
            "      if (!ed) return { ok: false, reason: 'no visible editor found' };\n"
            "      ed.focus();\n"
            "      const ce = ed.getAttribute('contenteditable') !== null && ed.tagName !== 'TEXTAREA' && ed.tagName !== 'INPUT';\n"
            f"      if ({clear_js}) {{\n"
            "        if (ce) { document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); }\n"
            "        else { const proto = ed instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;\n"
            "          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set; setter.call(ed, '');\n"
            "          ed.dispatchEvent(new Event('input', { bubbles: true })); }\n"
            "      } else if (ce) { const range = document.createRange(); range.selectNodeContents(ed); range.collapse(false);\n"
            "        const sel2 = getSelection(); sel2.removeAllRanges(); sel2.addRange(range); }\n"
            "      return { ok: true, kind: ce ? 'contenteditable' : ed.tagName.toLowerCase() }; })()"
        )
        focused = self._eval(session, tab, focus_expr) or {}
        if not focused.get("ok"):
            return {"ok": False, "error": focused.get("reason", "no visible editor found"), "tab_id": tab["targetId"]}
        if str(args.get("text") or ""):
            session["cdp"].send("Input.insertText", {"text": str(args["text"])}, tab["sessionId"])
        read = self._eval(session, tab, "(() => { /*arena-fill-read*/ const ed = document.activeElement; if (!ed) return { ok: false, value: '' }; return { ok: true, value: (ed.value !== undefined ? ed.value : (ed.innerText || '')).slice(0, 2000) }; })()") or {}
        return {"ok": True, "tab_id": tab["targetId"], "kind": focused.get("kind"), "value": read.get("value", "")}

    def _wait_for(self, session, tab, cond, timeout_sec):
        deadline = time.time() + max(1, min(float(timeout_sec or 15), 120))
        cond_json = json.dumps(cond or {})
        expr = (
            "(() => { /*arena-wait-check*/\n"
            f"      const c = {cond_json};\n"
            "      const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);\n"
            "        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };\n"
            "      const name = (e) => (e.getAttribute('aria-label') || e.innerText || e.value || e.getAttribute('placeholder') || '').trim();\n"
            "      const role = (e) => e.getAttribute('role') || e.tagName.toLowerCase();\n"
            "      const bodyText = document.body ? (document.body.innerText || '') : '';\n"
            "      switch (c.type) {\n"
            "        case 'text_present': return bodyText.includes(c.text || '');\n"
            "        case 'text_absent': return !bodyText.includes(c.text || '');\n"
            "        case 'dialog_closed': return ![...document.querySelectorAll('dialog[open],[role=\"dialog\"],[role=\"alertdialog\"]')].some(vis);\n"
            "        case 'composer_empty': { const sel = 'textarea,[contenteditable],[role=\"textbox\"],input[type=\"text\"],input[type=\"search\"],input:not([type])';\n"
            "          const ed = [...document.querySelectorAll(sel)].filter(vis)[0]; if (!ed) return false;\n"
            "          return ((ed.value !== undefined ? ed.value : (ed.innerText || '')).trim() === ''); }\n"
            "        case 'element_present': case 'element_absent': {\n"
            "          const els = [...document.querySelectorAll('a,button,input,textarea,select,[contenteditable],[role]')].filter(vis);\n"
            "          const found = els.some((e) => (!c.text || name(e).toLowerCase().includes(String(c.text).toLowerCase())) &&\n"
            "            (!c.role || role(e).toLowerCase().includes(String(c.role).toLowerCase())) &&\n"
            "            (!c.name || name(e).toLowerCase().includes(String(c.name).toLowerCase())));\n"
            "          return c.type === 'element_present' ? found : !found; }\n"
            "        default: return false;\n"
            "      } })()"
        )
        while True:
            try:
                ok = bool(self._eval(session, tab, expr))
            except Exception:
                ok = False
            if ok:
                return True
            if time.time() >= deadline:
                return False
            time.sleep(0.5)

    def _with_expect(self, session, tab, args, result):
        if not args.get("expect") or not result or result.get("ok") is False:
            return result
        verified = self._wait_for(session, tab, args["expect"], (args["expect"] or {}).get("timeout_sec") or 10)
        return {**result, "verified": verified, "expect": args["expect"]}

    def _observe_tool(self, args, ctx):
        session = self.session(args.get("session_id"))
        if not session:
            raise ValueError("no browser session — call chrome_launch or chrome_attach first")
        tab = self._tab(session, args.get("tab_id"))
        return self._observe(session, tab, args)

    def _fill_editor_tool(self, args, ctx):
        session = self.session(args.get("session_id"))
        if not session:
            raise ValueError("no browser session — call chrome_launch or chrome_attach first")
        tab = self._tab(session, args.get("tab_id"))
        res = self._fill_editor(session, tab, args)
        if res.get("ok") and args.get("submit"):
            self._press(session, tab, "Enter")
            res = {**res, "submitted": True}
        return self._with_expect(session, tab, args, res)

    def _wait_for_tool(self, args, ctx):
        session = self.session(args.get("session_id"))
        if not session:
            raise ValueError("no browser session — call chrome_launch or chrome_attach first")
        tab = self._tab(session, args.get("tab_id"))
        started = time.time()
        verified = self._wait_for(session, tab, args.get("condition") or {}, args.get("timeout_sec") or 15)
        return {"ok": True, "tab_id": tab["targetId"], "verified": verified,
                "condition": args.get("condition"), "elapsed_ms": int((time.time() - started) * 1000)}
