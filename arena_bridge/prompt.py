"""Builds the ready-to-paste instruction block for a cloud agent."""

from datetime import datetime

from .trust import trust_state


def build_prompt(cfg, base_url=None, tools=None) -> str:
    url = (base_url or cfg.get("publicUrl") or f"http://{cfg.get('host')}:{cfg.get('port')}").rstrip("/")
    target = cfg.get("device")
    token = cfg.get("token") or "<TOKEN>"
    roots = ", ".join(cfg.get("roots") or [])

    tool_lines = []
    for t in tools or []:
        first = (t.get("description") or "").split(".")[0]
        tool_lines.append(f"- `{t['name']}` — {first}.")

    trust = trust_state()
    if trust.get("active"):
        until = datetime.fromtimestamp(trust["until"] / 1000).strftime("%Y-%m-%d %H:%M")
        trust_line = (
            f"- A trust window is open until {until}: side-effecting actions run without confirmation."
        )
    else:
        trust_line = (
            "- Side-effecting actions (bash, writes, the user's own Chrome, desktop control) "
            "need a local approval."
        )

    return f"""# Arena Bridge — remote access to your own machine

You have controlled access to the user's own computer ("{target}") through a small HTTP API.
Base URL: {url}
Authentication: `Authorization: Bearer <token>` (send the token in the HEADER, never in the URL or query string).

## How to use it
Always send the token in the header. Example:

```bash
curl -sS -X POST "{url}/call" \\
  -H "Authorization: Bearer $ARENA_BRIDGE_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{{"tool":"bash","args":{{"command":"uname -a"}}}}'
```

The token is: {token}
(export it first: `export ARENA_BRIDGE_TOKEN='{token}'`)

## Endpoints
- `GET  /health`  — liveness (no auth)
- `GET  /tools`   — full tool catalog with JSON schemas
- `GET  /prompt`  — this document
- `POST /exec`    — {{"command":"...","cwd":"...","timeout_sec":120}}
- `POST /call`    — {{"tool":"bash","args":{{...}}}}
- `GET  /files?path=/abs/path` — raw file download
- `PUT  /files?path=/abs/path` — upload (raw body)
- `DELETE /files?path=/abs/path` — delete
- `POST /mcp`     — MCP Streamable HTTP endpoint (if you speak MCP)

## Tools
{chr(10).join(tool_lines)}

## Choosing the right tool
| The agent wants to | Use |
| --- | --- |
| read the content of a web page | `chrome_snapshot` (`{{"mode":"ax"}}` for roles/names, `{{"mode":"text"}}` for text, `{{"mode":"html"}}` for markup) |
| click something on a web page | `chrome_click` with a CSS selector or visible text |
| work in the user's own logged-in browser | `chrome_attach` (port 9222) then the same `chrome_*` tools |
| look at the whole screen or a native app | `mac_see` (screenshot + clickable element ids) |
| click a native app | `mac_click` with the element id from `mac_see`, a visible text, or `{{"x":..,"y":..}}` |
| type into a native app | `mac_type`, then `mac_key` for Enter/Tab/cmd+s |
| list or open applications | `mac_apps`, `mac_app_launch`, `mac_app_focus` |
| find a control by its name, without a screenshot | `mac_element` (accessibility API: name, role, value) |
| fill a field without typing and without focus | `mac_set` (sets the value through the accessibility API) |
| use the application menu | `mac_menu` to list, `mac_menu_click` to trigger an item by name |
| wait for a control to appear or vanish | `mac_wait` |
| work on a separate virtual desktop | `mac_spaces`, `mac_space_switch` |
| look at files | `list_dir` (top level only; add `{{"recursive":true}}` to go deeper), `read_file`, `search_files` |

## Browser control (Chrome over CDP)
1. `chrome_launch` starts a browser that belongs to you — own profile, no personal data.
   `{{"headless": true, "url": "https://example.com"}}` (headless=false opens a visible window).
2. Then `chrome_open` → `chrome_snapshot` → `chrome_click`/`chrome_type` → `chrome_screenshot`.
   `chrome_snapshot` with `{{"mode": "ax"}}` returns roles and names, which is the best input for clicking.
3. `chrome_attach` connects to the user's own Chrome (default port 9222, with their logged-in sessions).
   Actions on an attached browser require a local approval — ask for it instead of retrying.
4. Screenshots: pass `{{"path": "shot.png"}}` to save the PNG inside the authorized roots, then read it with `file_get`.
5. Named profiles keep their logins between runs: `chrome_launch {{"profile":"work"}}` opens
   `~/.arena-bridge/chrome-profiles/work`. `chrome_profiles` lists them. The user logs in once with
   `arena-bridge browser open work` on their machine - ask for that instead of trying to log in yourself.
6. A visible window can be kept small and out of the way: `chrome_launch {{"headless":false,"width":900,"height":700,"x":-920,"y":40}}`.

## Desktop control (macOS, through Peekaboo)
0. Prefer the accessibility API over pixels: controls are recognised by name and role, not by guessing
   coordinates. `mac_element` finds them, `mac_see` returns the same elements with ids plus a screenshot.
1. `mac_see` is the entry point: it takes a screenshot of the screen (or of one app window with
   `{{"app": "Safari", "mode": "window"}}`) and returns the clickable elements with their ids.
2. Then `mac_click` (by id, by visible text or by coordinates) → `mac_type` → `mac_key` → `mac_scroll`.
3. `mac_apps` and `mac_windows` show what is running; `mac_app_launch`/`mac_app_focus` open and switch.
4. If a capture or a click fails, run `mac_permissions` — macOS needs Screen Recording and
   Accessibility permissions for the terminal that runs the bridge.
5. Screenshots are saved as PNG inside the authorized roots; read them back with `file_get`.
6. Stay out of the user's way: do not pass `foreground`, do not focus windows and do not move the
   pointer unless the user asks for it. Background actions are delivered to the target window only.
7. `mac_set` writes a value straight into a control (no keystrokes, no focus change);
   `mac_menu_click` triggers a menu item by its name (it needs the `app` name) — both are more reliable than typing.
8. `mac_wait` waits for a control to appear or disappear instead of sleeping and guessing.
9. `mac_spaces` lists the macOS virtual desktops; `mac_space_switch` moves the agent to another
   Space so the user keeps the screen they are looking at.

## Work log with evidence
Every call is logged with its arguments, result and duration. Screenshots taken on the desktop and
the accessibility trees that were read are stored next to the log.
- `audit_log` — the recent calls (filter by tool or time).
- `audit_artifact` — fetch a saved artifact: a screenshot (base64 PNG) or an accessibility tree (JSON).
Use them when you need to look back at what was on the screen or what the interface contained.

## Approvals
{trust_line}
- When a call answers `APPROVAL_PENDING` it carries an `approval_id`: tell the user to run
  `arena-bridge approve <approval_id>` on their machine (or `arena-bridge trust --for 1h` to let you
  work hands-free until the window closes), then retry the call once. `GET /approvals` lists what is waiting.
- `APPROVAL_DENIED` means the user said no: do not retry, ask what to do instead.

## Rules
1. Paths are restricted to the authorized roots ({roots}).
   Reading or writing anything else returns `PROTECTED` — do not try to work around it.
2. Side-effecting tools (bash, write/edit/delete, process start/kill, actions on the user's own
   Chrome or on the desktop) may require a local human approval. When the answer contains
   `APPROVAL_PENDING`, tell the user which approval is pending and stop; they will run
   `arena-bridge approve <approval_id>` on their machine. Do not retry in a loop.
3. Work step by step: inspect before you change. Prefer `read_file`/`list_dir`/`search_files`
   over blind shell commands. `list_dir` returns the top level only unless you ask for `recursive`.
4. Long-running work (dev servers, watchers) belongs in `start_process` + `read_process_output`,
   not in a blocking `bash` call.
5. Never exfiltrate credentials; `.ssh`, `.aws`, browser profiles and similar locations are blocked.
6. Look before you click: take a snapshot (`chrome_snapshot` or `mac_see`) and act on what it shows.
"""
