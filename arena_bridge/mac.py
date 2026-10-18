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
    if node is None or depth > 8:
        return out
    if isinstance(node, list):
        for item in node:
            _collect_elements(item, out, depth + 1)
        return out
    if not isinstance(node, dict):
        return out
    for key in ("ui_elements", "elements"):
        elements = node.get(key)
        if not isinstance(elements, list) or not elements:
            continue
        for element in elements:
            if not isinstance(element, dict):
                continue
            value = element.get("value")
            out.append(
                {
                    "id": element.get("id") or element.get("element_id") or element.get("elementId"),
                    "role": element.get("role")
                    or element.get("ax_role")
                    or element.get("elementRole")
                    or element.get("type"),
                    "title": element.get("title")
                    or element.get("label")
                    or element.get("name")
                    or element.get("placeholder"),
                    "label": element.get("label"),
                    "description": element.get("description"),
                    "identifier": element.get("identifier"),
                    "value": value[:200] if isinstance(value, str) else value,
                    "bounds": element.get("bounds") or element.get("frame") or element.get("rect"),
                    "enabled": element.get("is_enabled") if element.get("is_enabled") is not None else element.get("enabled"),
                    "actionable": element.get("is_actionable"),
                    "settable": element.get("is_value_settable"),
                    "shortcut": element.get("keyboard_shortcut"),
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


PERMISSION_HINT = (
    "macOS did not let the bridge capture the screen. This usually happens right after a Peekaboo update: "
    "open System Settings → Privacy & Security → Screen Recording (and Accessibility), turn on "
    '"Peekaboo Bridge" and quit and reopen Peekaboo. The bridge also falls back to the local Peekaboo '
    "runtime, which needs the same grant for the app that starts the bridge (for example Terminal)."
)


def _peek_error(data):
    if not isinstance(data, dict):
        return None
    err = data.get("error")
    if isinstance(err, dict) and (err.get("code") or err.get("message")):
        return err
    return None


def _is_permission_error(cand):
    err = _peek_error(cand.get("data"))
    text = " ".join(
        str(x or "")
        for x in (err.get("code") if err else None, err.get("message") if err else None, cand.get("stderr"))
    )
    return any(k in text.lower() for k in ("permission", "screen recording", "accessibility", "event synthesizing"))


def _menu_flags(args):
    flags = []
    if args.get("app"):
        flags += ["--app", str(args["app"])]
    if args.get("pid"):
        flags += ["--pid", str(args["pid"])]
    return flags


def _menu_hint(res):
    text = (res.get("stderr") or res.get("stdout") or "").strip()
    if "multiple apps match" in text.lower():
        return "Several apps share that name — pass the process id from mac_apps: mac_menu {\"pid\":12345}."
    return text[:600]


def _windows_of_all_apps(bin_path):
    res = _run_variants(bin_path, [["app", "list", "--json"], ["list", "apps", "--json"]], timeout=30)
    data = _parse_json(res["stdout"])
    apps = data.get("apps") or data.get("data", {}).get("apps") or [] if isinstance(data, dict) else []
    out = []
    for app in apps[:6] if isinstance(apps, list) else []:
        if not isinstance(app, dict) or not app.get("pid"):
            continue
        w = _run(bin_path, ["window", "list", "--pid", str(app["pid"]), "--json"], timeout=20)
        wdata = _parse_json(w["stdout"])
        wins = wdata.get("windows") or wdata.get("data", {}).get("windows") or [] if isinstance(wdata, dict) else []
        for win in wins if isinstance(wins, list) else []:
            out.append({**win, "app": app.get("name"), "pid": app.get("pid")})
    return out


def _not_found():
    return {"ok": False, "error": "peekaboo_not_found", "hint": NOT_FOUND_HINT}


def mac_tools(cfg=None):
    cfg = cfg or {}

    def peek():
        bin_path = find_peekaboo(cfg)
        if not bin_path:
            return None
        return bin_path

    def see_variants(args, out_path):
        mode = "window" if args.get("mode") == "window" else "screen"
        base = ["see", "--mode", mode, *_target_flags(args)]
        if not out_path:
            return [
                ["see", "--tree", "--no-screenshot", "--json", *_target_flags(args)],
                ["see", "--tree", "--no-screenshot", "--no-remote", "--json", *_target_flags(args)],
                ["see", "--tree", "--json", *_target_flags(args)],
                ["see", "--no-remote", "--tree", "--json", *_target_flags(args)],
                ["see", "--json", *_target_flags(args)],
            ]
        return [
            [*base, "--json", "--path", out_path],
            [*base, "--path", out_path, "--json"],
            [*base, "--no-remote", "--json", "--path", out_path],
            ["see", "--mode", mode, *_target_flags(args), "--no-elements", "--json", "--path", out_path],
            [
                "see", "--mode", mode, *_target_flags(args), "--no-elements", "--no-remote", "--json", "--path", out_path
            ],
        ]

    def collect_see(args, out_path):
        best = None
        for variant in see_variants(args, out_path):
            res = _run(peek(), variant, timeout=60)
            data = _parse_json(res["stdout"])
            cand = {**res, "data": data, "elements": _collect_elements(data), "variant": variant}
            if best is None:
                best = cand
            if res["exit_code"] == 0 and cand["elements"]:
                return cand
            if res["exit_code"] == 0 and best["exit_code"] != 0:
                best = cand
            if res["exit_code"] != 0 and not _is_permission_error(cand) and not any(
                m in (res["stderr"] or "").lower() for m in UNKNOWN
            ):
                break
        return best or {"stdout": "", "stderr": "", "exit_code": -1, "data": None, "elements": [], "variant": []}

    def match_element(element, args):
        def q(value):
            return str(value if value is not None else "").lower()

        if args.get("name"):
            needle = q(args["name"])
            haystack = "\n".join(
                q(element.get(key)) for key in ("title", "label", "description", "identifier", "value", "id")
            )
            if needle not in haystack:
                return False
        if args.get("role") and q(args["role"]) not in q(element.get("role")):
            return False
        if args.get("value") and q(args["value"]) not in q(element.get("value")):
            return False
        return True

    def search_see(args):
        return collect_see(
            {
                "app": args.get("app"),
                "window_title": args.get("window_title"),
                "mode": args.get("mode") or "screen",
            },
            None,
        )

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
        seen = collect_see(args, out_path)
        res = seen
        data = seen["data"]
        elements = seen["elements"][:300]
        failure = _peek_error(data)
        if failure and not elements:
            return {
                "ok": False,
                "error": "peekaboo_failed",
                "reason": failure.get("message") or str(failure.get("code") or "peekaboo returned an error"),
                "hint": PERMISSION_HINT,
            }
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
        artifact = getattr(ctx, "artifact", None)
        if artifact:
            try:
                if saved:
                    artifact("screenshot", "screen.png", Path(out_path).read_bytes(), {"source": "mac_see"})
                if data is not None:
                    artifact(
                        "ax-tree",
                        "ax-tree.json",
                        json.dumps(data, indent=2, default=str),
                        {"source": "mac_see", "elements": len(elements)},
                    )
            except Exception:
                pass
        out = {
            "ok": True,
            "path": out_path,
            "saved": saved,
            "elements": elements,
            "element_count": len(elements),
            "hint": 'Click by element id: mac_click {"on":"<id>"} or by visible text: mac_click {"text":"Save"}. Find elements by name with mac_element.',
        }
        if not elements:
            out["hint"] += " No elements found — run mac_permissions: the element list comes from the macOS Accessibility API."

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
        variants = [["app", "list", "--json"], ["list", "apps", "--json"], ["app", "list"]]
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
        if not flags:
            return {
                "ok": True,
                "windows": _windows_of_all_apps(bin_path),
                "source": "per-app",
                "hint": "Pass app or pid to narrow the list down.",
            }
        variants = [
            ["window", "list", *flags, "--json"],
            ["list", "windows", *flags, "--json"],
            ["window", "list", *flags],
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

    def element(args, ctx):
        bin_path = peek()
        if not bin_path:
            return _not_found()
        seen = search_see(args)
        matches = [e for e in seen["elements"] if match_element(e, args)][: int(args.get("limit") or 25)]
        artifact = getattr(ctx, "artifact", None)
        if artifact and seen.get("data") is not None:
            artifact(
                "ax-tree",
                "ax-tree.json",
                json.dumps(seen["data"], indent=2, default=str),
                {"source": "mac_element", "elements": len(seen["elements"]), "query": args.get("name") or args.get("role")},
            )
        return {
            "ok": True,
            "matches": matches,
            "count": len(matches),
            "scanned": len(seen["elements"]),
            "hint": 'Act on a match by id: mac_click {"on":"<id>"} or mac_set {"on":"<id>","value":"..."}.',
        }

    def set_value(args, ctx):
        bin_path = peek()
        if not bin_path:
            return _not_found()
        flags = _target_flags(args)
        on = str(args.get("on"))
        value = str(args.get("value"))
        variants = [
            ["set-value", value, "--on", on, *flags],
            ["set-value", value, "--on", on],
            ["set-value", "--on", on, value, *flags],
            ["set-value", "--on", on, "--value", value, *flags],
        ]
        return _finish(_run_variants(bin_path, variants, timeout=30), "set-value")

    def menu(args, ctx):
        bin_path = peek()
        if not bin_path:
            return _not_found()
        flags = _menu_flags(args)
        res = _run_variants(
            bin_path,
            [["menu", "list", *flags, "--no-remote", "--json"], ["menu", "list", *flags, "--json"], ["menu", "list", *flags]],
            timeout=30,
        )
        data = _parse_json(res["stdout"])
        artifact = getattr(ctx, "artifact", None)
        if artifact and data is not None:
            artifact("menu-tree", "menu-tree.json", json.dumps(data, indent=2, default=str), {"source": "mac_menu"})
        payload = data
        if isinstance(data, dict):
            payload = (
                data.get("menus")
                or data.get("data", {}).get("menus")
                or data.get("data", {}).get("menu_structure")
                or data
            )
        return {
            "ok": res["exit_code"] == 0,
            "menus": payload if data is not None else None,
            "output": None if data is not None else (res["stdout"] or "")[:4000],
            "error": None if res["exit_code"] == 0 else (res["stderr"] or "").strip()[:600],
            "hint": None if res["exit_code"] == 0 else _menu_hint(res),
        }

    def menu_click(args, ctx):
        bin_path = peek()
        if not bin_path:
            return _not_found()
        if not args.get("item") and not args.get("path"):
            return {"ok": False, "error": "missing_item", "hint": 'Pass item ("Save") or path ("File > Export").'}
        if not args.get("app") and not args.get("pid"):
            return {
                "ok": False,
                "error": "missing_app",
                "hint": 'A background menu click needs an explicit app: mac_menu_click {"app":"Safari","item":"Save"}.',
            }
        flags = _menu_flags(args)
        if args.get("path"):
            variants = [
                ["menu", "click", "--path", str(args["path"]), *flags, "--no-remote"],
                ["menu", "click", "--path", str(args["path"]), *flags],
            ]
        else:
            item = str(args.get("item"))
            variants = [
                ["menu", "click", "--item", item, *flags, "--no-remote"],
                ["menu", "click", "--item", item, *flags],
            ]
        return _finish(_run_variants(bin_path, variants, timeout=30), "menu-click")

    def spaces(args, ctx):
        bin_path = peek()
        if not bin_path:
            return _not_found()
        res = _run_variants(
            bin_path,
            [["space", "list", "--no-remote", "--json"], ["space", "list", "--json"], ["space", "list"]],
            timeout=30,
        )
        data = _parse_json(res["stdout"])
        artifact = getattr(ctx, "artifact", None)
        if artifact and data is not None:
            artifact("spaces", "spaces.json", json.dumps(data, indent=2, default=str), {"source": "mac_spaces"})
        payload = data
        if isinstance(data, dict):
            payload = data.get("spaces") or data.get("data", {}).get("spaces") or data
        return {
            "ok": res["exit_code"] == 0,
            "spaces": payload if data is not None else None,
            "output": None if data is not None else (res["stdout"] or "")[:4000],
            "error": None if res["exit_code"] == 0 else (res["stderr"] or "").strip()[:600],
        }

    def space_switch(args, ctx):
        bin_path = peek()
        if not bin_path:
            return _not_found()
        target = str(args.get("to"))
        variants = [
            ["space", "switch", "--to", target, "--foreground", "--no-remote"],
            ["space", "switch", "--to", target, "--foreground"],
        ]
        return _finish(_run_variants(bin_path, variants, timeout=30), "space-switch")

    def wait_element(args, ctx):
        bin_path = peek()
        if not bin_path:
            return _not_found()
        limit = min(120, max(1, int(args.get("timeout") or 20)))
        deadline = time.time() + limit
        scanned = 0
        last = None
        while time.time() < deadline:
            seen = search_see(args)
            last = seen
            scanned = len(seen["elements"])
            hit = next((e for e in seen["elements"] if match_element(e, args)), None)
            if args.get("disappear"):
                if hit is None:
                    return {"ok": True, "gone": True, "found": False, "scanned": scanned}
            elif hit is not None:
                return {"ok": True, "found": True, "element": hit, "scanned": scanned}
            time.sleep(2)
        artifact = getattr(ctx, "artifact", None)
        if artifact and last and last.get("data") is not None:
            artifact(
                "ax-tree",
                "ax-tree.json",
                json.dumps(last["data"], indent=2, default=str),
                {"source": "mac_wait", "elements": scanned},
            )
        return {
            "ok": False,
            "found": False,
            "error": "not_found",
            "reason": f"no matching element within {limit}s",
            "scanned": scanned,
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
            "name": "mac_element",
            "description": "Find interface elements by visible name, role or value through the macOS accessibility API. No screenshots, no pixel guessing. Read-only.",
            "approval": False,
            "schema": obj(
                {
                    "name": {"type": "string", "description": "visible text or title to look for"},
                    "role": {"type": "string", "description": "e.g. button, textField, menuItem, staticText"},
                    "value": {"type": "string"},
                    "app": {"type": "string"},
                    "window_title": {"type": "string"},
                    "limit": {"type": "number"},
                }
            ),
            "required": [],
            "handler": element,
        },
        {
            "name": "mac_set",
            "description": "Set the value of an element directly through the accessibility API — fills a field without focusing the window and without simulated keystrokes.",
            "approval": True,
            "schema": obj(
                {
                    "on": {"type": "string", "description": "element id from mac_see / mac_element"},
                    "value": {"type": "string"},
                    "app": {"type": "string"},
                    "window_id": {"type": "string"},
                },
                ["on", "value"],
            ),
            "required": ["on", "value"],
            "handler": set_value,
        },
        {
            "name": "mac_menu",
            "description": "List the menu items of an application through the accessibility API. Read-only.",
            "approval": False,
            "schema": obj({"app": {"type": "string"}}, []),
            "required": [],
            "handler": menu,
        },
        {
            "name": "mac_menu_click",
            "description": 'Trigger a menu item by name (e.g. "Save", "Copy Link") or a nested path ("File > Export") — no pointer, no coordinates.',
            "approval": True,
            "schema": obj(
                {
                    "item": {"type": "string", "description": "name of the menu item"},
                    "path": {"type": "string", "description": 'nested path, e.g. "File > Export"'},
                    "app": {"type": "string", "description": "required: the background menu click needs a target app"},
                }
            ),
            "required": [],
            "handler": menu_click,
        },
        {
            "name": "mac_spaces",
            "description": "List the macOS Spaces (virtual desktops) and which one is active. Read-only.",
            "approval": False,
            "schema": obj({}, []),
            "required": [],
            "handler": spaces,
        },
        {
            "name": "mac_space_switch",
            "description": "Move to another Space so the agent works on a separate virtual desktop and the user keeps the screen they are on.",
            "approval": True,
            "schema": obj({"to": {"type": "string", "description": "space id or index from mac_spaces"}}, ["to"]),
            "required": ["to"],
            "handler": space_switch,
        },
        {
            "name": "mac_wait",
            "description": "Wait until an element with the given name/role appears (or disappears) and report what was seen. Read-only.",
            "approval": False,
            "schema": obj(
                {
                    "name": {"type": "string"},
                    "role": {"type": "string"},
                    "value": {"type": "string"},
                    "disappear": {"type": "boolean", "description": "wait until the element is gone"},
                    "timeout": {"type": "number", "description": "seconds, default 20, max 120"},
                    "app": {"type": "string"},
                }
            ),
            "required": [],
            "handler": wait_element,
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
