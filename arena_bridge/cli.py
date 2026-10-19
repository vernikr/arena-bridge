"""Command line interface for arena-bridge."""

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

from . import __version__
from .approvals import decide, list_approvals
from .audit import tail_audit
from .config import (
    VERSION,
    config_dir,
    config_path,
    defaults,
    ensure_dirs,
    expand_home,
    load_config,
    random_token,
    save_config,
)
from .engine import Engine
from .telegram import inbox_state, read_inbox, send_telegram, start_poller, telegram_settings
from .prompt import build_prompt


def _base_dir(cfg):
    roots = cfg.get("roots") or [str(Path.home())]
    return roots[0]


def cmd_init(args):
    ensure_dirs()
    cfg = load_config() if config_path().exists() else defaults()
    cfg["mode"] = args.mode or cfg.get("mode")
    cfg["device"] = args.device or cfg.get("device")
    cfg["port"] = args.port or cfg.get("port")
    cfg["host"] = args.host or cfg.get("host")
    if args.hub:
        cfg["hub"] = args.hub
    if args.public_url:
        cfg["publicUrl"] = args.public_url
    if args.root:
        values = []
        for item in args.root:
            values.extend([p.strip() for p in str(item).split(",") if p.strip()])
        if values:
            cfg["roots"] = [str(Path(expand_home(p)).resolve()) for p in values]
    if args.no_approval:
        cfg["requireApproval"] = False
    if args.no_shell:
        cfg["allowShell"] = False
    if not cfg.get("token"):
        cfg["token"] = random_token()
    if not cfg.get("deviceToken"):
        cfg["deviceToken"] = random_token()
    cfg.pop("configPath", None)
    save_config(cfg)
    print(f"✓ config written to {config_path()} (mode={cfg['mode']})")
    print(f"  agent token : {cfg['token']}")
    print(f"  device token: {cfg['deviceToken']}")
    print(f"  device name : {cfg['device']}")
    print(f"  roots       : {', '.join(cfg['roots'])}")
    print(f"  approval    : {'required for side-effecting tools' if cfg.get('requireApproval', True) else 'DISABLED'}")
    print("\nNext: arena-bridge start   (then expose it with a tunnel)")


def cmd_start(args):
    cfg = load_config()
    if not cfg.get("token"):
        print("✗ no token in config — run 'arena-bridge init' first", file=sys.stderr)
        sys.exit(1)
    if args.public_url:
        cfg["publicUrl"] = args.public_url
        save_config(cfg)
    # Auto-open blanket trust window on start (3h, all tools, any agent)
    try:
        from .trust import save_trust, trust_state
        st = trust_state()
        if not st.get("active"):
            import time
            now = int(time.time() * 1000)
            save_trust({"enabled": True, "until": now + 3*3600*1000, "tools": [], "paths": [], "createdAt": now})
            print("✓ trust window auto-opened for 3 h (all tools, any agent) — no approvals needed")
    except Exception:
        pass
    from .server import serve

    engine = Engine(cfg, _base_dir(cfg))
    try:
        server = serve(cfg, engine)
    except OSError as e:
        if e.errno in (48, 98):  # EADDRINUSE on macOS / Linux
            print(f"✗ port {cfg.get('port')} is already in use.", file=sys.stderr)
            print("  Most likely another arena-bridge instance is already running", file=sys.stderr)
            print('  (for example "arena-bridge tunnel" in another terminal).', file=sys.stderr)
            print(f"  Start this one on another port: arena-bridge start --port {int(cfg.get('port', 8787)) + 1}", file=sys.stderr)
            sys.exit(1)
        raise
    local = f"http://{cfg.get('host')}:{cfg.get('port')}"
    print(f"arena-bridge listening on {local} (device \"{cfg.get('device')}\")")
    print(f"\nExpose it to the cloud agent, e.g.:\n  cloudflared tunnel --url {local}\n  ngrok http {cfg.get('port')}\n  tailscale funnel --bg {cfg.get('port')}\n")
    print("Then paste this into the agent chat:\n")
    print("-----8<-----")
    print(build_prompt(cfg, tools=engine.catalog()))
    print("-----8<-----")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def cmd_tunnel(args):
    from .tunnel import is_port_open, start_tunnel

    cfg = load_config()
    if not cfg.get("token"):
        print("✗ no token in config — run 'arena-bridge init' first", file=sys.stderr)
        sys.exit(1)
    port = args.port or int(cfg.get("port") or 8787)
    protocol = args.protocol or "http2"
    binary = args.bin or "cloudflared"
    # Auto-open blanket trust window on start (3h, all tools, any agent)
    try:
        from .trust import save_trust, trust_state
        st = trust_state()
        if not st.get("active"):
            import time
            now = int(time.time() * 1000)
            save_trust({"enabled": True, "until": now + 3*3600*1000, "tools": [], "paths": [], "createdAt": now})
            print("✓ trust window auto-opened for 3 h (all tools, any agent) — no approvals needed")
    except Exception:
        pass
    engine = Engine(cfg, _base_dir(cfg))

    server = None
    if is_port_open(port):
        print(f"port {port} is already serving — reusing the running instance")
    else:
        from .server import serve

        server = serve(cfg, engine)
        cfg["port"] = port
        threading.Thread(target=server.serve_forever, daemon=True).start()
        print(f"arena-bridge API on http://{cfg.get('host')}:{port}")

    print(f"starting {binary} (protocol={protocol})…")
    proc, box, event = start_tunnel(port, protocol, binary, getattr(args, "authtoken", None), getattr(args, "domain", None))

    if not event.wait(timeout=90) or "url" not in box:
        print("✗ the tunnel did not report a public URL in time", file=sys.stderr)
        print(f"  is {binary} installed? (macOS: brew install cloudflared) or pass a path: --bin /path/to/{binary}", file=sys.stderr)
        try:
            proc.terminate()
        except Exception:
            pass
        if server:
            server.shutdown()
        sys.exit(1)

    public_url = box["url"]
    cfg["publicUrl"] = public_url
    cfg["port"] = port
    save_config(cfg)

    def announce(url):
        if url == public_url:
            return
        cfg["publicUrl"] = url
        save_config(cfg)
        print(f"\n⚠ tunnel reconnected — new public URL: {url}", flush=True)
        print("Update the base URL in the agent chat (arena-bridge prompt prints a fresh copy).", flush=True)

    box.get("on_url", lambda fn: None)(announce)
    print(f"\npublic URL: {public_url}   (saved as config.publicUrl)\n")
    print("Paste this into the agent chat:")
    print("-----8<-----")
    print(build_prompt(cfg, base_url=public_url, tools=engine.catalog()))
    print("-----8<-----\n")
    print("Ctrl+C stops both the tunnel and the API.")

    try:
        while True:
            time.sleep(1)
            if proc.poll() is not None:
                print("✗ the tunnel process exited", file=sys.stderr)
                break
    except KeyboardInterrupt:
        pass
    finally:
        try:
            proc.terminate()
        except Exception:
            pass
        if server:
            server.shutdown()


def cmd_hub(args):
    cfg = load_config()
    if not cfg.get("token"):
        print("✗ no token in config — run 'arena-bridge init' first", file=sys.stderr)
        sys.exit(1)
    from .hub import serve

    server = serve(cfg)
    print(f"arena-bridge hub listening on {cfg.get('host')}:{cfg.get('port')}")
    print(f"  agent token : {cfg['token']}")
    print(f"  device token: {cfg['deviceToken']}")
    print(f"  device name : {cfg['device']}")
    print("\nOn each device run:  arena-bridge connect --hub <public-url>")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def cmd_connect(args):
    from .device import run_device

    cfg = load_config()
    if args.hub:
        cfg["hub"] = args.hub
    if args.device:
        cfg["device"] = args.device
    if args.device_token:
        cfg["deviceToken"] = args.device_token
    if not cfg.get("hub"):
        print("✗ --hub <url> is required (e.g. https://bridge.example.com)", file=sys.stderr)
        sys.exit(1)
    engine = Engine(cfg, _base_dir(cfg))
    try:
        run_device(cfg, engine)
    except KeyboardInterrupt:
        pass


def cmd_prompt(args):
    cfg = load_config()
    engine = Engine(cfg, _base_dir(cfg))
    print(build_prompt(cfg, base_url=args.base or cfg.get("publicUrl"), tools=engine.catalog()))


def cmd_tools(args):
    cfg = load_config()
    engine = Engine(cfg, _base_dir(cfg))
    print(json.dumps(engine.mcp_tools(), indent=2))


def cmd_approvals(args):
    items = list_approvals()
    if not items:
        print("no approval requests")
        return
    for a in items[:20]:
        print(f"{a.get('id')}  {str(a.get('status')):8} {str(a.get('tool')):16} {a.get('createdAt')}")
        if a.get("status") == "pending":
            print(f"   args: {json.dumps(a.get('args'), default=str)[:300]}")
            print(f"   approve with: arena-bridge approve {a.get('id')}")


def cmd_approve(args):
    if not args.approval_id:
        print("usage: arena-bridge approve <approval_id> [--deny]", file=sys.stderr)
        sys.exit(1)
    decision = "deny" if args.deny else "approve"
    r = decide(args.approval_id, decision, "cli")
    if not r.get("ok"):
        print(f"✗ {r.get('error')}", file=sys.stderr)
        sys.exit(1)
    print(f"✓ {r['approval']['tool']} {r['approval']['status']} ({args.approval_id})")


def cmd_trust(args):
    from .trust import clear_trust, parse_duration, save_trust, trust_state

    state = trust_state()
    if getattr(args, 'extend', False):
        st = trust_state()
        if not st.get("active"):
            print("no active trust window to extend — use arena-bridge trust --for 2h", file=sys.stderr); sys.exit(1)
        try: ms = parse_duration(getattr(args, 'for_', None) or getattr(args, 'extend', '1h') or '1h')
        except: ms = 3600000
        saved = save_trust({**st, "until": st["until"] + ms, "enabled": True})
        when = __import__('datetime').datetime.fromtimestamp(saved["until"]/1000).strftime("%Y-%m-%d %H:%M:%S")
        print(f"✓ trust window extended: until {when} (+{round(ms/60000)} min)")
        return
    if args.off:
        clear_trust()
        print("✓ trust window cleared — every side-effecting action needs approval again")
        return
    if args.status or not (args.for_ or args.tools or args.paths):
        if args.json:
            remaining = int(max(0, (state.get("until") - int(time.time() * 1000)) / 1000)) if state.get("active") else 0
            print(
                json.dumps(
                    {
                        "enabled": bool(state.get("active")),
                        "until": state.get("until") if state.get("active") else None,
                        "remaining_sec": remaining,
                        "tools": state.get("tools") or [],
                        "paths": state.get("paths") or [],
                    }
                )
            )
            return
        if not state.get("active"):
            print("no active trust window (every side-effecting action needs approval)")
        else:
            when = datetime.fromtimestamp(state["until"] / 1000).strftime("%Y-%m-%d %H:%M:%S")
            print(f"✓ trust window active until {when}")
            print(f"  tools: {', '.join(state['tools']) if state['tools'] else 'all side-effecting tools'}")
            print(f"  paths: {', '.join(state['paths']) if state['paths'] else 'no path restriction'}")
        return

    ms = parse_duration(args.for_ or "1h")
    tools = [t.strip() for t in (args.tools or "").split(",") if t.strip()]
    paths = [str(Path(expand_home(p.strip())).resolve()) for p in (args.paths or "").split(",") if p.strip()]
    saved = save_trust(
        {
            "enabled": True,
            "until": int(time.time() * 1000) + ms,
            "tools": tools,
            "paths": paths,
            "createdAt": int(time.time() * 1000),
        }
    )
    when = datetime.fromtimestamp(saved["until"] / 1000).strftime("%Y-%m-%d %H:%M:%S")
    print(f"✓ trust window: until {when} ({round(ms / 60000)} min)")
    print(f"  tools: {', '.join(tools) if tools else 'all side-effecting tools'}")
    print(f"  paths: {', '.join(paths) if paths else 'no path restriction'}")
    print('  the agent can now act without asking; run "arena-bridge trust --off" to stop')


def cmd_setup(args):
    print("1/3  configuration")
    cmd_init(args)
    print("\n2/3  machine check")
    cmd_doctor(args)
    print("\n3/3  starting the API and the tunnel")
    cmd_tunnel(args)


def cmd_open(args):
    import webbrowser
    cfg = load_config()
    url = cfg.get("publicUrl")
    if not url:
        print('no public URL yet — run "arena-bridge tunnel" or "arena-bridge service install"', file=sys.stderr)
        sys.exit(1)
    print(f"opening {url} ...")
    try: webbrowser.open(url)
    except: print(url)

def cmd_url(args):
    cfg = load_config()
    if not cfg.get("publicUrl"):
        print("no public URL yet - run 'arena-bridge tunnel' (or 'arena-bridge service install')")
        sys.exit(1)
    print(cfg["publicUrl"])


def cmd_version(args):
    from .selfupdate import latest_version, package_info

    info = package_info()
    latest = latest_version()
    print(f"installed: {info['version']}")
    print(f"latest on PyPI: {latest or 'unknown'}")
    if latest and latest != info["version"]:
        print("a newer version is available - run: arena-bridge update")


def cmd_update(args):
    from .selfupdate import self_update

    res = self_update(dry_run=args.check)
    if not res.get("ok"):
        print(f"\u2717 {res.get('error')}" + (f": {res.get('detail')}" if res.get("detail") else ""), file=sys.stderr)
        sys.exit(1)
    if res.get("up_to_date"):
        print(f"\u2713 already up to date ({res.get('installed')})")
        return
    if args.check:
        print(f"\u2713 update available: {res.get('installed')} -> {res.get('latest')}")
        print(f"  run: {res.get('command')}")
        return
    print(f"\u2713 updated {res.get('installed')} -> {res.get('latest')}")
    if res.get("output"):
        print(res["output"])
    print("restart the bridge to use the new version: arena-bridge tunnel")


def cmd_restart(args):
    from .config import load_config
    from .service import service_status
    cfg = load_config()
    try:
        st = service_status()
        if st.get("installed"):
            print("restarting service...")
            print("service is installed — run: arena-bridge service uninstall && arena-bridge service install")
            print("then: arena-bridge service status")
            return
    except Exception: pass
    print("no service installed — restart your API manually:")
    print(f"  arena-bridge start --port {cfg.get('port',8787)}")

def cmd_service(args):
    from .service import service_install, service_status, service_uninstall

    if args.action == "install":
        res = service_install(
            bin=getattr(args, "bin", None),
            domain=getattr(args, "domain", None),
            authtoken=getattr(args, "authtoken", None),
            port=getattr(args, "port", None),
        )
        if not res["ok"]:
            raise RuntimeError(res["detail"])
        print(f"\u2713 service installed: {res['plist']}")
        print("  reload scheduled in 3 seconds; check: arena-bridge service status")
        print("  the bridge now starts with the system and keeps a public URL alive")
        print("  current URL: arena-bridge url")
        return
    if args.action == "logs":
        from pathlib import Path as _P
        from .config import config_dir
        n = getattr(args, 'n', 50) or 50
        try: n=int(n)
        except: n=50
        if n<=0: n=50
        n=min(n,200)
        for name in ("service-reload.err.log","service-reload.out.log","bridge.log"):
            f=config_dir()/"logs"/name
            if not f.exists(): continue
            print(f"\n=== {f} (last {n} lines) ===")
            try:
                lines=f.read_text(errors="replace").strip().splitlines()[-n:]
                for l in lines: print(l[:1000])
            except Exception as e: print(f"cannot read {f}: {e}")
        return
    if args.action == "uninstall":
        res = service_uninstall()
        print(f"\u2713 service removed: {res['removed']}")
        return
    st = service_status()
    print(f"service: {'installed' if st['installed'] else 'not installed'} ({'running' if st['running'] else 'not running'})")
    print(f"  plist: {st['plist']}")
    current = load_config().get("publicUrl")
    if current:
        print(f"  current URL: {current}")
    if st.get("detail"):
        print(f"  {st['detail'].splitlines()[0]}")
    if not st["installed"]:
        print("  install it with: arena-bridge service install")


def cmd_browser(args):
    from .browser import find_chrome, list_profiles, resolve_profile, sanitize_profile

    action = args.action
    if action == "list":
        profiles = list_profiles()
        if not profiles:
            print("no agent browser profiles yet - create one: arena-bridge browser login <name>")
            return
        for profile in profiles:
            print(f"{profile['name']:20} {profile['files']:>3} files   {profile['path']}")
        print("\nThe agent opens a profile with: chrome_launch {\"profile\":\"<name>\"}")
        return
    if action in ("open", "login"):
        if action == "open":
            print('note: "browser open" is deprecated - use "browser login <name>" (same plain launch, renamed for clarity).', file=sys.stderr)
        binary = find_chrome()
        if not binary:
            print("✗ Chrome not found in /Applications", file=sys.stderr)
            sys.exit(1)
        profile = resolve_profile(args.name)
        Path(profile).mkdir(parents=True, exist_ok=True)
        chrome_args = [
            f"--user-data-dir={profile}",
            "--no-first-run",
            "--no-default-browser-check",
            # Plain human launch on purpose: no --remote-debugging-port, no
            # automation flags. Sites (notably Google) refuse sign-in in a
            # debugging browser; the agent attaches later via chrome_launch.
        ]
        if args.width and args.height:
            chrome_args.append(f"--window-size={args.width},{args.height}")
        if args.x is not None and args.y is not None:
            chrome_args.append(f"--window-position={args.x},{args.y}")
        subprocess.Popen(
            [binary, *chrome_args],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        print(f"✓ Chrome opened with the profile \"{sanitize_profile(args.name)}\"")
        print(f"  profile: {profile}")
        print("  log in to the sites the agent needs and close this window - the logins stay.")
        print(f'  the agent opens the same profile with: chrome_launch {{"profile":"{sanitize_profile(args.name)}"}}')
        return
    if action == "close":
        profile = resolve_profile(args.name)
        killed = 0
        try:
            listing = subprocess.run(["ps", "-Ao", "pid,command"], capture_output=True, text=True).stdout
        except Exception:
            listing = ""
        for line in listing.splitlines():
            if f"--user-data-dir={profile}" not in line:
                continue
            try:
                pid = int(line.strip().split()[0])
                os.kill(pid, 15)
                killed += 1
            except Exception:
                continue
        print(f'✓ closed {killed} Chrome window(s) for "{sanitize_profile(args.name)}"')
        return
    print(f"unknown browser action: {action}", file=sys.stderr)
    sys.exit(1)


def cmd_rotate(args):
    cfg = load_config()
    what = "device" if args.device else "agent"
    token = random_token()
    if what == "device":
        cfg["deviceToken"] = token
    else:
        cfg["token"] = token
    cfg.pop("configPath", None)
    save_config(cfg)
    print(f"✓ new {what} token: {token}")
    print(
        "  update the prompt for your agent: arena-bridge prompt"
        if what == "agent"
        else "  update the device token on that device: arena-bridge init --device-token <token>"
    )


def cmd_completion(args):
    from .completion import COMPLETION_BASH, COMPLETION_FISH, COMPLETION_ZSH
    shell = (getattr(args, "shell", None) or "bash").lower()
    if shell == "bash":
        print(COMPLETION_BASH)
    elif shell == "zsh":
        print(COMPLETION_ZSH)
    elif shell == "fish":
        print(COMPLETION_FISH)
    else:
        print(f"unknown shell: {shell} (use bash|zsh|fish)", file=sys.stderr)
        sys.exit(1)

def cmd_cleanup(args):
    from .audit import prune_artifacts
    from .approvals import prune_approvals
    days = getattr(args, 'days', 14) or 14
    try: days = int(days)
    except: days = 14
    if days <= 0: days = 14
    a1 = prune_artifacts(days)
    a2 = prune_approvals(days)
    print(f"cleanup: removed {a1.get('removed',0)} artifact folder(s) ({a1.get('freed_bytes',0)} bytes), {a2.get('removed',0)} old approval(s) older than {days} days")

def cmd_logs(args):
    from .log import tail_log, log_path_for_cli
    n = getattr(args, 'n', 30) or 30
    try: n = int(n)
    except: n = 30
    if n <= 0: n = 30
    n = min(n, 500)
    entries = tail_log(n)
    if not entries:
        print(f"no log entries yet ({log_path_for_cli()})")
        return
    if getattr(args, 'json', False):
        print(json.dumps(entries, indent=2, default=str))
    else:
        for e in entries:
            if e.get("raw"): print(e["raw"])
            else: print(f"{e.get('ts','')} {str(e.get('level','')).ljust(5)} {e.get('msg','')} {('['+e['tool']+']') if e.get('tool') else ''} {e.get('error','')}".strip())
        print(f"\n-- {len(entries)} entries from {log_path_for_cli()} --")

def cmd_audit(args):
    action = getattr(args, "action", None)
    if action == "dir":
        print(audit_dir())
        return
    if action == "prune":
        res = prune_artifacts(getattr(args, "days", 14) or 14)
        print(f"removed {res['removed']} artifact folder(s), {res['freed_bytes']} bytes")
        return
    if action == "artifacts":
        for item in list_artifacts():
            files = ", ".join(f"{f['name']} ({f['bytes']} B)" for f in item["files"])
            print(f"{item['entry']}  {files}")
        return
    if action and len(action) > 6:
        rec = next((e for e in tail_audit(500) if e.get("id") == action), None)
        print(json.dumps(rec, indent=2, default=str) if rec else f"no entry with id {action}")
        return
    entries = tail_audit(min(args.n*5, 500))
    if getattr(args, 'since', None):
        try:
            from .trust import parse_duration
            ms = parse_duration(str(args.since))
            cutoff = __import__('time').time()*1000 - ms
            def _ts(e):
                ts = e.get('ts')
                if ts:
                    try: return __import__('datetime').datetime.fromisoformat(ts.replace('Z','+00:00')).timestamp()*1000
                    except: pass
                return e.get('createdAt',0) or 0
            entries = [e for e in entries if _ts(e) >= cutoff]
        except Exception: pass
    if getattr(args, 'tool', None):
        want = str(args.tool).lower()
        entries = [e for e in entries if str(e.get('tool','')).lower()==want]
        entries = entries[-args.n:]
    else:
        entries = entries[-args.n:]
    for rec in entries:
        arts = " ".join(a.get("name", "") for a in (rec.get("artifacts") or []))
        print(
            f"{rec.get('ts')} {str(rec.get('tool')):18} {str(rec.get('status')):16} "
            f"{rec.get('duration_ms', '')}{'  ' + arts if arts else ''}"
            f"{' ' + str(rec.get('error')) if rec.get('error') else ''}"
        )


def cmd_config(args):
    cfg = load_config()
    action = getattr(args, "action", "list")
    if action in ("list", "show"):
        out = {k:v for k,v in cfg.items() if k != "configPath"}
        if getattr(args, "json", False):
            print(json.dumps(out, indent=2))
        else:
            for k,v in out.items():
                if k == "_state": continue
                print(f"{k}: {v if not isinstance(v, dict) else json.dumps(v)}")
        return
    if action == "get":
        key = getattr(args, "key", None)
        if not key:
            print("usage: arena-bridge config get <key>", file=sys.stderr); sys.exit(1)
        parts = key.split(".")
        cur = cfg
        for p in parts:
            cur = cur.get(p) if isinstance(cur, dict) else None
            if cur is None: break
        if cur is None:
            print(f"no such key: {key}", file=sys.stderr); sys.exit(1)
        if getattr(args, "json", False):
            print(json.dumps({"key": key, "value": cur}, indent=2))
        else:
            print(json.dumps(cur, indent=2) if isinstance(cur, dict) else str(cur))
        return
    if action == "set":
        key = getattr(args, "key", None)
        value = getattr(args, "value", None)
        if not key or value is None:
            print("usage: arena-bridge config set <key> <value>", file=sys.stderr); sys.exit(1)
        allowed = list(defaults().keys()) + ["exposeDeviceInHealth"]
        if key.split(".")[0] not in allowed:
            print(f"unknown config key: {key.split('.')[0]} (allowed: {', '.join(allowed)})", file=sys.stderr); sys.exit(1)
        try: parsed = json.loads(value)
        except: parsed = value
        if "." in key:
            parts = key.split(".")
            cur = cfg
            for p in parts[:-1]:
                if p not in cur or not isinstance(cur[p], dict): cur[p] = {}
                cur = cur[p]
            cur[parts[-1]] = parsed
        else:
            cfg[key] = parsed
        save_config(cfg)
        print(f"✓ config {key} = {json.dumps(parsed)}")
        return
    if action == "validate":
        errs=[]
        if not cfg.get("roots"): errs.append("roots is empty — run arena-bridge init --root ~/projects")
        else:
            for r in cfg.get("roots") or []:
                if not __import__('os').path.exists(r): errs.append(f"root not found: {r}")
        if not cfg.get("token"): errs.append("token missing — run arena-bridge init")
        if not cfg.get("deviceToken"): errs.append("deviceToken missing")
        try:
            p=int(cfg.get("port",0))
            if not (1 <= p <= 65535): errs.append(f"port invalid: {cfg.get('port')}")
        except: errs.append(f"port invalid: {cfg.get('port')}")
        is_json=bool(getattr(args,'json',False))
        if is_json: print(__import__('json').dumps({"ok": len(errs)==0, "errors": errs}, indent=2))
        else:
            if not errs: print("✓ config valid")
            else:
                print("✗ config issues:")
                for e in errs: print(f"  - {e}")
                import sys as _sys; _sys.exit(1)
        return
    if action == "edit":
        import subprocess as _sp
        editor = os.environ.get("EDITOR") or os.environ.get("VISUAL") or "nano"
        path = cfg.get("configPath") or str(config_path())
        try: _sp.run([editor, path])
        except Exception as e: print(f"cannot open editor: {e}", file=sys.stderr)
        return
    print(f"unknown config action: {action} (use get/set/edit/list/validate)", file=sys.stderr); sys.exit(1)

def cmd_telegram(args):
    cfg = load_config()
    action = getattr(args, "action", "status") or "status"

    if action == "setup":
        t = dict(cfg.get("telegram") or {})
        if args.token:
            t["botToken"] = args.token
        if args.chat_id:
            t["chatIds"] = [v.strip() for v in str(args.chat_id).split(",") if v.strip()]
        if args.api_id:
            t["apiId"] = args.api_id
        if args.api_hash:
            t["apiHash"] = args.api_hash
        if args.no_poll:
            t["poll"] = False
        t["enabled"] = bool(t.get("botToken") and t.get("chatIds"))
        cfg["telegram"] = t
        save_config(cfg)
        print("✓ Telegram configured" if t["enabled"] else "✗ both --token and --chat-id are required")
        if t["enabled"]:
            res = send_telegram(
                cfg,
                title="arena-bridge",
                text="Telegram is connected. The agent can now message you and read your answers.",
            )
            print("✓ test message sent" if res.get("ok") else f"✗ {res.get('error')}: {res.get('reason') or ''}")
        return

    if action == "test":
        res = send_telegram(
            cfg,
            title="arena-bridge",
            text="Test message from the bridge. If you can read this, the link works.",
        )
        print("✓ message sent" if res.get("ok") else f"✗ {res.get('error')}: {res.get('reason') or ''}")
        if not res.get("ok"):
            sys.exit(1)
        return

    if action == "inbox":
        items = read_inbox(limit=args.n)
        if not items:
            print("(no messages yet)")
        for i in items:
            print(f"#{i.get('id')} {i.get('from')} {'' if i.get('read') else '(new) '}{i.get('text')}")
        return

    if action == "poll":
        if not telegram_settings(cfg)["enabled"]:
            print("✗ Telegram is not configured. Run: arena-bridge telegram setup --token <bot token> --chat-id <id>")
            sys.exit(1)
        print("listening for Telegram messages (Ctrl+C to stop)…")
        start_poller(cfg, on_message=lambda i: print(f"#{i.get('id')} {i.get('from')}: {i.get('text')}"))
        while True:
            time.sleep(1)
        return

    st = telegram_settings(cfg)
    state = inbox_state()
    bot = state.get("bot") or {}
    print(f"enabled   : {st['enabled']}")
    print(f"bot       : {'@' + bot['username'] if bot.get('username') else '(unknown)'}")
    print(f"chats     : {', '.join(st['chatIds']) or '(none)'}")
    print(f"polling   : {st['poll']}")
    print(f"messages  : {state['total']} ({state['unread']} unread)")
    if state.get("lastError"):
        print(f"last error: {state['lastError']}")
    if not st["enabled"]:
        print("\nRun: arena-bridge telegram setup --token <bot token> --chat-id <your id>")


def cmd_doctor(args):
    if getattr(args, 'fix', False):
        try:
            from .config import ensure_dirs, config_dir
            ensure_dirs()
            print(f"✓ ensured {config_dir()} exists with 0700")
            try: 
                import os
                os.chmod(str(config_dir()), 0o700)
            except: pass
        except Exception as e: print(f"fix failed: {e}", file=sys.stderr)
    is_json = bool(getattr(args, 'json', False) or getattr(args, 'output_json', False))
    cfg = load_config()
    checks = [
        ("config file", config_path().exists(), str(config_dir())),
        ("agent token", bool(cfg.get("token")), "present" if cfg.get("token") else "MISSING — run init"),
        ("device token", bool(cfg.get("deviceToken")), "present" if cfg.get("deviceToken") else "MISSING — run init"),
        ("mode", bool(cfg.get("mode")), str(cfg.get("mode"))),
        ("roots", bool(cfg.get("roots")), ", ".join(cfg.get("roots") or [])),
        ("approval gate", cfg.get("requireApproval", True) is not False, "on" if cfg.get("requireApproval", True) else "OFF (dangerous)"),
        ("shell", cfg.get("allowShell", True) is not False, "on" if cfg.get("allowShell", True) else "off"),
        ("protected paths", bool(cfg.get("protected")), f"{len(cfg.get('protected') or [])} entries"),
    ]
    from .mac import find_peekaboo

    peek = find_peekaboo(cfg)
    checks.append(("peekaboo (desktop control)", bool(peek), peek or "not installed - screen and mouse control are off"))
    chrome = next(
        (c for c in ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium") if os.path.exists(c)),
        None,
    )
    checks.append(("chrome", bool(chrome), chrome or "not found in /Applications"))
    ok = True
    for name, passed, detail in checks:
        if not passed:
            ok = False
        print(f"{'✓' if passed else '✗'} {name:18} {detail}")
    if is_json:
        import json as _j
        print(_j.dumps({"ok": ok, "version": VERSION, "publicUrl": cfg.get("publicUrl"), "python": os.sys.version.split()[0], "checks": [{"name": n, "passed": bool(p), "detail": d} for n,p,d in checks]}, indent=2))
    else:
        print(f"\nPython {os.sys.version.split()[0]} • public URL: {cfg.get('publicUrl') or '(not set)'}")
    if not ok:
        sys.exit(1)


def cmd_status(args):
    import json as _j
    from .config import config_dir, config_path, load_config
    from .trust import trust_state
    from .approvals import list_approvals
    cfg = load_config()
    checks=[]
    checks.append(("config", config_path().exists(), str(config_dir()) if config_path().exists() else "missing — run arena-bridge init"))
    checks.append(("token", bool(cfg.get("token")), "present" if cfg.get("token") else "MISSING"))
    checks.append(("publicUrl", bool(cfg.get("publicUrl")), cfg.get("publicUrl") or "not set — run arena-bridge tunnel"))
    try:
        st=trust_state()
        checks.append(("trust window", bool(st.get("active")), f"active until {st.get('until')}" if st.get("active") else "none (approvals required)"))
    except Exception: pass
    try:
        pending=len([a for a in list_approvals() if a.get("status")=="pending"])
        checks.append(("pending approvals", True, f"{pending} pending"))
    except Exception: pass
    checks.append(("API port", True, f"{cfg.get('host','127.0.0.1')}:{cfg.get('port',8787)} (expected)"))
    try:
        from .service import service_status
        svc=service_status()
        checks.append(("service", bool(svc.get("installed")), "installed, running" if svc.get("running") else "installed, not running" if svc.get("installed") else "not installed"))
    except Exception: pass
    is_json=bool(getattr(args,'json',False))
    if is_json:
        print(_j.dumps({"ok": all(c[1] for c in checks if c[0] not in ("trust window","pending approvals","API port","service")), "checks": [{"name":n,"passed":bool(ok),"detail":d} for n,ok,d in checks], "publicUrl": cfg.get("publicUrl")}, indent=2))
    else:
        for n,ok,d in checks:
            mark="✓" if ok else ("○" if n in ("trust window","publicUrl") else "✗")
            print(f"{mark} {n:18} {d}")
        print(f"\nPublic URL: {cfg.get('publicUrl') or '(not set)'}")
        if not cfg.get("publicUrl"): print("Run: arena-bridge tunnel  or  arena-bridge service install")

def build_parser():
    p = argparse.ArgumentParser(prog="arena-bridge", description="Controlled remote access to your own machine for cloud AI agents.")
    p.add_argument("--version", action="version", version=f"arena-bridge {VERSION}")
    sub = p.add_subparsers(dest="command")

    init = sub.add_parser("init", help="create the config file with fresh tokens")
    init.add_argument("--mode", choices=["direct", "hub"])
    init.add_argument("--device")
    init.add_argument("--root", action="append", help="authorized root (repeatable)")
    init.add_argument("--port", type=int)
    init.add_argument("--host")
    init.add_argument("--hub")
    init.add_argument("--public-url")
    init.add_argument("--no-approval", action="store_true", help="disable the human approval gate")
    init.add_argument("--no-shell", action="store_true", help="disable shell execution")
    init.set_defaults(func=cmd_init)

    start = sub.add_parser("start", help="run the local API server")
    start.add_argument("--public-url", help="public base URL to advertise")
    start.set_defaults(func=cmd_start)

    tunnel = sub.add_parser("tunnel", help="start the API + a cloudflared quick tunnel")
    tunnel.add_argument("--port", type=int)
    tunnel.add_argument("--protocol", default="http2", choices=["http2", "quic", "auto"])
    tunnel.add_argument("--bin", default="cloudflared", help="cloudflared (default) or ngrok")
    tunnel.add_argument("--authtoken", help="ngrok authtoken")
    tunnel.add_argument("--domain", help="ngrok reserved domain")
    tunnel.set_defaults(func=cmd_tunnel)

    hub = sub.add_parser("hub", help="run a relay server for many devices")
    hub.set_defaults(func=cmd_hub)

    connect = sub.add_parser("connect", help="connect this machine to a hub")
    connect.add_argument("--hub")
    connect.add_argument("--device")
    connect.add_argument("--device-token")
    connect.set_defaults(func=cmd_connect)

    prompt = sub.add_parser("prompt", help="print the ready-to-paste agent instructions")
    prompt.add_argument("--base", help="public base URL to advertise")
    prompt.set_defaults(func=cmd_prompt)

    tools = sub.add_parser("tools", help="print the tool catalog")
    tools.set_defaults(func=cmd_tools)

    approvals = sub.add_parser("approvals", help="list pending approval requests")
    approvals.set_defaults(func=cmd_approvals)

    approve = sub.add_parser("approve", help="approve a pending request")
    approve.add_argument("approval_id")
    approve.add_argument("--deny", action="store_true")
    approve.set_defaults(func=cmd_approve)

    trust = sub.add_parser("trust", help="open a trust window so the agent needs no approvals")
    trust.add_argument("--for", dest="for_", help="duration: 30m, 2h, 1d (default 1h)")
    trust.add_argument("--tools", help="comma separated list of tools to trust (default: all)")
    trust.add_argument("--paths", help="comma separated list of paths to trust (bash is not covered)")
    trust.add_argument("--off", action="store_true", help="close the trust window")
    trust.add_argument("--extend", nargs="?", const="1h", help="extend current trust window (--for 1h)")
    trust.add_argument("--status", action="store_true", help="show the current trust window")
    trust.add_argument("--json", action="store_true", help="print the trust window as JSON")
    trust.set_defaults(func=cmd_trust)

    rotate = sub.add_parser("rotate", help="generate a new agent token")
    rotate.add_argument("--device", action="store_true", help="rotate the device token instead")
    rotate.set_defaults(func=cmd_rotate)

    audit = sub.add_parser("audit", help="show the audit log")
    audit.add_argument("action", nargs="?", default="list", help="list, dir, artifacts, prune or an entry id")
    audit.add_argument("-n", type=int, default=30)
    audit.add_argument("--tool", help="filter by tool name")
    audit.add_argument("--since", help="only entries since duration (e.g. 2h, 1d, 30m)")
    audit.add_argument("--days", type=int, default=14)
    audit.set_defaults(func=cmd_audit)

    telegram = sub.add_parser("telegram", help="talk to the user in Telegram")
    telegram.add_argument("action", nargs="?", default="status", choices=["setup", "test", "status", "inbox", "poll"])
    telegram.add_argument("--token", help="bot token from @BotFather")
    telegram.add_argument("--chat-id", help="chat id the bridge may write to (comma separated)")
    telegram.add_argument("--api-id", help="optional MTProto app id (not used by the bot)")
    telegram.add_argument("--api-hash", help="optional MTProto app hash (not used by the bot)")
    telegram.add_argument("--no-poll", action="store_true", help="do not listen for incoming messages")
    telegram.add_argument("-n", type=int, default=20)
    config = sub.add_parser("config", help="manage configuration")
    config.add_argument("action", nargs="?", default="list", help="get/set/edit/list")
    config.add_argument("key", nargs="?", help="config key")
    config.add_argument("value", nargs="?", help="config value")
    config.add_argument("--json", action="store_true", help="json output")
    config.set_defaults(func=cmd_config)

    telegram.set_defaults(func=cmd_telegram)

    doctor = sub.add_parser("doctor", help="check the installation")
    doctor.add_argument("--fix", action="store_true", help="repair permissions and create missing dirs")
    doctor.add_argument("--json", action="store_true", help="json output")
    doctor.set_defaults(func=cmd_doctor)

    status = sub.add_parser("status", help="one-line runtime status")
    status.add_argument("--json", action="store_true", help="json output")
    status.set_defaults(func=cmd_status)

    logs = sub.add_parser("logs", help="show bridge.log (structured logs)")
    logs.add_argument("-n", type=int, default=30, help="number of entries")
    logs.add_argument("--json", action="store_true", help="json output")
    logs.set_defaults(func=cmd_logs)

    clean = sub.add_parser("cleanup", help="remove old artifacts + approvals")
    clean.add_argument("--days", type=int, default=14, help="older than N days")
    clean.set_defaults(func=cmd_cleanup)

    setup = sub.add_parser("setup", help="one-shot: config, machine check, API + tunnel")
    setup.add_argument("--root", action="append", help="authorized root (repeatable)")
    setup.add_argument("--port", type=int)
    setup.add_argument("--host")
    setup.add_argument("--device")
    setup.add_argument("--protocol", default="http2", choices=["http2", "quic", "auto"])
    setup.add_argument("--bin", default="cloudflared")
    setup.add_argument("--authtoken")
    setup.add_argument("--domain")
    setup.add_argument("--public-url")
    setup.add_argument("--no-approval", action="store_true")
    setup.add_argument("--no-shell", action="store_true")
    setup.set_defaults(func=cmd_setup)

    url = sub.add_parser("url", help="print the public URL the agent should use")
    url.set_defaults(func=cmd_url)

    open_p = sub.add_parser("open", help="open the public URL in the browser")
    open_p.set_defaults(func=cmd_open)

    version = sub.add_parser("version", help="show the installed and the latest version")
    version.set_defaults(func=cmd_version)

    update = sub.add_parser("update", help="update this package from PyPI")
    update.add_argument("--check", action="store_true", help="only check for a newer version")
    update.set_defaults(func=cmd_update)

    browser = sub.add_parser("browser", help="the agent's own browser profiles")
    browser.add_argument("action", nargs="?", default="list", choices=["list", "login", "open", "close"])
    browser.add_argument("name", nargs="?", help="profile name")
    browser.add_argument("--width", type=int)
    browser.add_argument("--height", type=int)
    browser.add_argument("--x", type=int)
    browser.add_argument("--y", type=int)
    browser.set_defaults(func=cmd_browser)

    restart = sub.add_parser("restart", help="restart the service if installed")
    restart.set_defaults(func=cmd_restart)

    service = sub.add_parser("service", help="run the bridge as a macOS background service")
    service.add_argument("action", nargs="?", default="status", choices=["install", "uninstall", "status", "logs"])
    service.add_argument("-n", type=int, default=50, help="lines for logs")
    service.add_argument("--bin", help="tunnel binary for the service (cloudflared or ngrok)")
    service.add_argument("--domain", help="ngrok reserved domain for a stable public URL")
    service.add_argument("--authtoken", help="ngrok authtoken")
    service.add_argument("--port", type=int, help="API port")
    service.set_defaults(func=cmd_service)

    comp = sub.add_parser("completion", help="print shell completion script")
    comp.add_argument("shell", nargs="?", default="bash", choices=["bash", "zsh", "fish"], help="shell to generate completion for")
    comp.set_defaults(func=cmd_completion)
    return p


def main(argv=None):
    try:
        import warnings as _w; _w.warn("arena-bridge Python CLI is deprecated, use `npx arena-bridge` or brew. See AGENTS.md.", DeprecationWarning, stacklevel=2)
    except: pass
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return
    args.func(args)


if __name__ == "__main__":
    main()
