"""macOS desktop control through the Peekaboo CLI."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

from .policy import check_path

PEEKABOO_CANDIDATES = [
    "/usr/local/bin/peekaboo",
    "/opt/homebrew/bin/peekaboo",
    "/opt/local/bin/peekaboo",
    "/Applications/Peekaboo.app/Contents/MacOS/peekaboo",
    str(Path.home() / ".local/bin/peekaboo"),
    str(Path.home() / ".peekaboo/bin/peekaboo"),
    str(Path.home() / "bin/peekaboo"),
]

NOT_FOUND_HINT = (
    "peekaboo is not installed on this machine. Install it (macOS: brew install peekaboo, "
    "or download the release from https://github.com/openclaw/Peekaboo) and make sure the binary is on PATH."
)

UNKNOWN = (
    "unknown command",
    "unrecognized command",
    "invalid command",
    "no such command",
    "unknown subcommand",
    "usage:",
)


def find_peekaboo(cfg=None):
    cfg = cfg or {}
    explicit = cfg.get("peekabooPath") or os.environ.get("PEEKABOO_PATH")
    if explicit and os.path.exists(explicit):
        return explicit
    for candidate in PEEKABOO_CANDIDATES:
        if os.path.exists(candidate):
            return candidate
    found = shutil.which("peekaboo")
    return found


def _run(bin_path, args, timeout=60):
    try:
        proc = subprocess.run(
            [bin_path, *args],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return {
            "stdout": proc.stdout or "",
            "stderr": proc.stderr or "",
            "exit_code": proc.returncode,
        }
    except subprocess.TimeoutExpired:
        return {"stdout": "", "stderr": "timeout", "exit_code": -1}
    except OSError as exc:
        return {"stdout": "", "stderr": str(exc), "exit_code": -1}


def _run_variants(bin_path, variants, timeout=60):
    last = None
    for args in variants:
        res = _run(bin_path, args, timeout=timeout)
        last = {**res, "args": args}
        if res["exit_code"] == 0:
            return last
        if not any(marker in (res["stderr"] or "").lower() for marker in UNKNOWN):
            return last
    return last


def _parse_json(text):
    if not text:
        return None
    start = min((i for i in (text.find("["), text.find("{")) if i >= 0), default=-1)
    if start < 0:
        return None
    try:
        return json.loads(text[start:])
    except ValueError:
        return None


def _collect_elements(node, out=None, depth=0):
    out = [] if out is None else out
    if node is None or depth > 6:
        return out
    if isinstance(node, list):
        for item in node:
            _collect_elements(item, out, depth + 1)
        return out
    if not isinstance(node, dict):
        return out
    elements = node.get("elements")
    if isinstance(elements, list):
        for element in elements:
            value = element.get("value")
            out.append(
                {
                    "id": element.get("id") or element.get("elementId") or element.get("element_id"),
                    "role": element.get("role") or element.get("elementRole") or element.get("type"),
                    "title": element.get("title")
                    or element.get("label")
                    or element.get("name")
                    or element.get("placeholder"),
                    "value": value[:200] if isinstance(value, str) else None,
                    "bounds": element.get("frame") or element.get("bounds") or element.get("rect"),
                    "enabled": element.get("enabled"),
                }
            )
        return out
    for value in node.values():
        if isinstance(value, (dict, list)):
            _collect_elements(value, out, depth + 1)
    return out


def _shot_dir(cfg):
    roots = cfg.get("roots") or []
    base = Path(roots[0]) / ".arena-bridge" / "shots" if roots else Path(os.environ.get("TMPDIR", "/tmp")) / "arena-bridge-shots"
    return str(base)


def _default_shot_path(cfg):
    stamp = time.strftime("%Y-%m-%dT%H-%M-%S")
    return str(Path(_shot_dir(cfg)) / f"screen-{stamp}.png")


def _target_flags(args):
    flags = []
    if args.get("app"):
        flags += ["--app", str(args["app"])]
    if args.get("pid"):
        flags += ["--pid", str(args["pid"])]
    if args.get("window_id"):
        flags += ["--window-id", str(args["window_id"])]
    if args.get("window_title"):
        flags += ["--window-title", str(args["window_title"])]
    if args.get("window_index") is not None:
        flags += ["--window-index", str(args["window_index"])]
    return flags


def _finish(res, action):
    if res["exit_code"] == 0:
        out = (res["stdout"] or "").strip()
        return {"ok": True, "action": action, "output": out[:2000] or None}
    return {
        "ok": False,
        "error": f"{action}_failed",
        "reason": (res.get("stderr") or res.get("stdout") or "").strip()[:800],
        "hint": "If this is a permissions problem, run mac_permissions and check Screen Recording / Accessibility.",
    }


def _not_found():
    return {"ok": False, "error": "peekaboo_not_found", "hint": NOT_FOUND_HINT}


def mac_tools(cfg=None):
    cfg = cfg or {}

    def peek():
        bin_path = find_peekaboo(cfg)
        if not bin_path:
            return None
        return bin_path

    def see(args, ctx):
        bin_path = peek()
        if not bin_path:
            return _not_found()
        cfg_now = getattr(ctx, "cfg", None) or cfg
        base = getattr(ctx, "base", None) or os.getcwd()
        path_arg = args.get("path")
        if path_arg:
            ok, abs_path, err, reason = check_path(str(path_arg), cfg_now, base)
            if not ok:
                return {"ok": False, "error": err, "reason": reason}
            out_path = str(abs_path)
        else:
            out_path = _default_shot_path(cfg_now)
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        mode = "window" if args.get("mode") == "window" else "screen"
        flags = _target_flags(args)
        variants = [
            ["see", "--mode", mode, *flags, "--json", "--path", out_path],
            ["see", "--mode", mode, *flags, "--path", out_path, "--json"],
            ["image", "--mode", mode, *flags, "--json", "--path", out_path],
        ]
        res = _run_variants(bin_path, variants, timeout=60)
        data = _parse_json(res["stdout"])
        elements = _collect_elements(data)[:300]
        saved = os.path.exists(out_path)
        if not saved:
            fb = _run("/usr/sbin/screencapture", ["-x", "-o", out_path], timeout=30)
            if fb["exit_code"] != 0 or not os.path.exists(out_path):
                return {
                    "ok": False,
                    "error": "capture_failed",
                    "reason": (res["stderr"] or "").strip()[:800],
                    "hint": "Grant Screen Recording permission to the app that runs the bridge.",
                }
        out = {
            "ok": True,
            "path": out_path,
            "saved": saved,
            "elements": elements,
            "element_count": len(elements),
            "hint": 'Click by element id: mac_click {"on":"<id>"} or by visible text: mac_click {"text":"Save"}',
        }
        if args.get("include_raw") and data is not None:
            out["raw"] = data
        return out

    def click(args, ctx):
        bin_path = peek()
        if not bin_path:
            return _not_found()
        flags = _target_flags(args)
        base = ["click"]
        if args.get("on"):
            base += ["--on", str(args["on"])]
        if args.get("text"):
            base += [str(args["text"])]
        if args.get("x") is not None and args.get("y") is not None:
            base += ["--at", f"{args['x']},{args['y']}"]
        base += flags
        if args.get("double"):
            base += ["--double"]
        if args.get("right"):
            base += ["--right"]
        if args.get("foreground"):
            base += ["--foreground"]
        variants = [base]
        if args.get("text"):
            variants.append(["click", "--on", str(args["text"]), *flags])
        if args.get("on"):
            variants.append(["click", "--on", str(args["on"])])
        return _finish(_run_variants(bin_path, variants, timeout=45), "click")

    def type_text(args, ctx):
        bin_path = peek()
        if not bin_path:
            return _not_found()
        flags = _target_flags(args)
        text = str(args.get("text", ""))
        variants = [["type", text, *flags], ["type", "--text", text, *flags]]
        if args.get("clear"):
            variants.insert(0, ["type", text, "--clear", *flags])
        res = _run_variants(bin_path, variants, timeout=45)
        if args.get("submit") and res["exit_code"] == 0:
            _run(bin_path, ["press", "Return", *flags], timeout=20)
        return _finish(res, "type")

    def key(args, ctx):
        bin_path = peek()
        if not bin_path:
            return _not_found()
        flags = _target_flags(args)
        count = ["--count", str(args["count"])] if args.get("count") else []
        variants = [["press", str(args.get("key")), *count, *flags], ["press", str(args.get("key")), *flags]]
        return _finish(_run_variants(bin_path, variants, timeout=30), "press")

    def scroll(args, ctx):
        bin_path = peek()
        if not bin_path:
            return _not_found()
        direction = "up" if args.get("direction") == "up" else "down"
        flags = _target_flags(args)
        on = ["--on", str(args["on"])] if args.get("on") else []
        variants = [
            ["scroll", "--direction", direction, "--ticks", str(args.get("ticks") or 3), *on, *flags],
            ["scroll", "--direction", direction, *on, *flags],
        ]
        return _finish(_run_variants(bin_path, variants, timeout=30), "scroll")

    def move(args, ctx):
        bin_path = peek()
        if not bin_path:
            return _not_found()
        point = f"{args.get('x')},{args.get('y')}"
        variants = [["move", "--at", point], ["move", "--coords", point]]
        return _finish(_run_variants(bin_path, variants, timeout=20), "move")

    def drag(args, ctx):
        bin_path = peek()
        if not bin_path:
            return _not_found()
        args_cmd = [
            "drag",
            "--from",
            f"{args.get('from_x')},{args.get('from_y')}",
            "--to",
            f"{args.get('to_x')},{args.get('to_y')}",
        ]
        return _finish(_run_variants(bin_path, [args_cmd], timeout=30), "drag")

    def apps(args, ctx):
        bin_path = peek()
        if not bin_path:
            return _not_found()
        variants = [["list", "apps", "--json"], ["app", "list", "--json"], ["list", "apps"]]
        res = _run_variants(bin_path, variants, timeout=30)
        data = _parse_json(res["stdout"])
        payload = data
        if isinstance(data, dict):
            payload = data.get("apps") or data.get("data", {}).get("apps") or data
        return {
            "ok": res["exit_code"] == 0,
            "apps": payload if data is not None else None,
            "output": None if data is not None else (res["stdout"] or "")[:4000],
            "error": None if res["exit_code"] == 0 else (res["stderr"] or "").strip()[:600],
        }

    def windows(args, ctx):
        bin_path = peek()
        if not bin_path:
            return _not_found()
        flags = ["--app", str(args["app"])] if args.get("app") else []
        variants = [
            ["list", "windows", *flags, "--json"],
            ["window", "list", *flags, "--json"],
            ["list", "windows", *flags],
        ]
        res = _run_variants(bin_path, variants, timeout=30)
        data = _parse_json(res["stdout"])
        payload = data
        if isinstance(data, dict):
            payload = data.get("windows") or data.get("data", {}).get("windows") or data
        return {
            "ok": res["exit_code"] == 0,
            "windows": payload if data is not None else None,
            "output": None if data is not None else (res["stdout"] or "")[:4000],
            "error": None if res["exit_code"] == 0 else (res["stderr"] or "").strip()[:600],
        }

    def app_launch(args, ctx):
        bin_path = peek()
        if not bin_path:
            return _not_found()
        name = str(args.get("name"))
        return _finish(_run_variants(bin_path, [["app", "launch", name], ["app", "open", name]], timeout=45), "launch")

    def app_focus(args, ctx):
        bin_path = peek()
        if not bin_path:
            return _not_found()
        name = str(args.get("name"))
        return _finish(_run_variants(bin_path, [["app", "focus", name], ["app", "switch", name]], timeout=30), "focus")

    def app_quit(args, ctx):
        bin_path = peek()
        if not bin_path:
            return _not_found()
        name = str(args.get("name"))
        return _finish(_run_variants(bin_path, [["app", "quit", name], ["app", "hide", name]], timeout=30), "quit")

    def permissions(args, ctx):
        bin_path = peek()
        if not bin_path:
            return {
                **_not_found(),
                "macos_permissions": "Screen Recording and Accessibility are required for capture and synthetic input.",
            }
        res = _run_variants(bin_path, [["permissions"], ["permissions", "--json"]], timeout=30)
        return {
            "ok": res["exit_code"] == 0,
            "permissions": (res["stdout"] or "")[:4000] or None,
            "error": None if res["exit_code"] == 0 else (res["stderr"] or "").strip()[:600],
            "hint": "System Settings → Privacy & Security → Screen Recording / Accessibility → enable the terminal that runs the bridge.",
        }

    def obj(props, required=None):
        return {
            "type": "object",
            "properties": props or {},
            "required": required or [],
            "additionalProperties": False,
        }

    return [
        {
            "name": "mac_see",
            "description": "Look at the screen: capture a screenshot (optionally of one app window) and list the clickable elements with their ids. Read-only.",
            "approval": False,
            "schema": obj(
                {
                    "app": {"type": "string", "description": 'application name, e.g. "Safari"'},
                    "window_title": {"type": "string"},
                    "mode": {"type": "string", "description": "screen (default) or window"},
                    "path": {"type": "string", "description": "where to save the PNG (defaults inside the first authorized root)"},
                    "include_raw": {"type": "boolean"},
                }
            ),
            "required": [],
            "handler": see,
        },
        {
            "name": "mac_click",
            "description": "Click on the screen: an element id from mac_see, a visible text, or coordinates.",
            "approval": True,
            "schema": obj(
                {
                    "on": {"type": "string", "description": "element id from mac_see"},
                    "text": {"type": "string", "description": "visible text of the element to click"},
                    "x": {"type": "number"},
                    "y": {"type": "number"},
                    "app": {"type": "string"},
                    "window_id": {"type": "string"},
                    "window_title": {"type": "string"},
                    "double": {"type": "boolean"},
                    "right": {"type": "boolean"},
                    "foreground": {"type": "boolean", "description": "focus the app before clicking"},
                }
            ),
            "required": [],
            "handler": click,
        },
        {
            "name": "mac_type",
            "description": "Type text into the focused element of an app window.",
            "approval": True,
            "schema": obj(
                {
                    "text": {"type": "string"},
                    "app": {"type": "string"},
                    "window_id": {"type": "string"},
                    "window_title": {"type": "string"},
                    "submit": {"type": "boolean", "description": "press Enter afterwards"},
                    "clear": {"type": "boolean", "description": "clear the field first"},
                },
                ["text"],
            ),
            "required": ["text"],
            "handler": type_text,
        },
        {
            "name": "mac_key",
            "description": 'Press a key or a chord in an app: Return, Tab, Escape, cmd+s, cmd+shift+p, arrows, etc.',
            "approval": True,
            "schema": obj(
                {
                    "key": {"type": "string", "description": 'key name or chord, e.g. "cmd+s"'},
                    "count": {"type": "number"},
                    "app": {"type": "string"},
                    "window_id": {"type": "string"},
                },
                ["key"],
            ),
            "required": ["key"],
            "handler": key,
        },
        {
            "name": "mac_scroll",
            "description": "Scroll up/down in the focused app or on a given element.",
            "approval": True,
            "schema": obj(
                {
                    "direction": {"type": "string", "description": "up or down"},
                    "ticks": {"type": "number", "description": "how many steps, default 3"},
                    "on": {"type": "string", "description": "element id from mac_see"},
                    "app": {"type": "string"},
                    "window_id": {"type": "string"},
                },
                ["direction"],
            ),
            "required": ["direction"],
            "handler": scroll,
        },
        {
            "name": "mac_move",
            "description": "Move the mouse pointer to coordinates (no click).",
            "approval": True,
            "schema": obj({"x": {"type": "number"}, "y": {"type": "number"}}, ["x", "y"]),
            "required": ["x", "y"],
            "handler": move,
        },
        {
            "name": "mac_drag",
            "description": "Drag from one point to another (sliders, files, text selection).",
            "approval": True,
            "schema": obj(
                {
                    "from_x": {"type": "number"},
                    "from_y": {"type": "number"},
                    "to_x": {"type": "number"},
                    "to_y": {"type": "number"},
                }
            ),
            "required": ["from_x", "from_y", "to_x", "to_y"],
            "handler": drag,
        },
        {
            "name": "mac_apps",
            "description": "List running applications with their ids and frontmost state. Read-only.",
            "approval": False,
            "schema": obj({"include_background": {"type": "boolean"}}),
            "required": [],
            "handler": apps,
        },
        {
            "name": "mac_windows",
            "description": "List the windows of the running applications (ids, titles, bounds). Read-only.",
            "approval": False,
            "schema": obj({"app": {"type": "string"}}),
            "required": [],
            "handler": windows,
        },
        {
            "name": "mac_app_launch",
            "description": "Launch an application by name.",
            "approval": True,
            "schema": obj({"name": {"type": "string"}}, ["name"]),
            "required": ["name"],
            "handler": app_launch,
        },
        {
            "name": "mac_app_focus",
            "description": "Bring an application to the front.",
            "approval": True,
            "schema": obj({"name": {"type": "string"}}, ["name"]),
            "required": ["name"],
            "handler": app_focus,
        },
        {
            "name": "mac_app_quit",
            "description": "Quit an application.",
            "approval": True,
            "schema": obj({"name": {"type": "string"}}, ["name"]),
            "required": ["name"],
            "handler": app_quit,
        },
        {
            "name": "mac_permissions",
            "description": "Check the macOS permissions the bridge needs (Screen Recording, Accessibility). Read-only.",
            "approval": False,
            "schema": obj({}),
            "required": [],
            "handler": permissions,
        },
    ]
