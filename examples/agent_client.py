#!/usr/bin/env python3
"""
Tiny client for the cloud agent side. Copy this file into the agent's sandbox
and run it — it only needs the standard library.

    export ARENA_BRIDGE_URL="https://xxx.trycloudflare.com"
    export ARENA_BRIDGE_TOKEN="<token>"

    python3 agent_client.py devices
    python3 agent_client.py call bash '{"command":"uname -a"}'
    python3 agent_client.py exec "ls -la ~/projects"
    python3 agent_client.py prompt
    python3 agent_client.py tools
"""
import json
import os
import sys
import urllib.error
import urllib.request

URL = os.environ.get("ARENA_BRIDGE_URL", "http://127.0.0.1:8787").rstrip("/")
TOKEN = os.environ.get("ARENA_BRIDGE_TOKEN", "")


def call(path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": f"Bearer {TOKEN}"}
    if data:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{URL}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        body_raw = e.read().decode(errors="replace")
        try:
            return json.loads(body_raw)
        except Exception:
            return {"ok": False, "error": body_raw}


def main(argv):
    if not argv:
        print(__doc__)
        return 1
    cmd, *rest = argv

    if cmd == "devices":
        print(json.dumps(call("/devices"), indent=2))
    elif cmd == "tools":
        print(json.dumps(call("/tools"), indent=2))
    elif cmd == "prompt":
        req = urllib.request.Request(f"{URL}/prompt", headers={"Authorization": f"Bearer {TOKEN}"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            print(resp.read().decode())
    elif cmd == "call":
        if not rest:
            print("usage: agent_client.py call <tool> [json-args]", file=sys.stderr)
            return 1
        tool = rest[0]
        args = json.loads(rest[1]) if len(rest) > 1 else {}
        result = call("/call", "POST", {"tool": tool, "args": args})
        print(json.dumps(result, indent=2))
        if not result.get("ok"):
            print(
                "\nIf this is a PROTECTED error, ask the user to run "
                f"`arena-bridge approve {result.get('approval_id')}` on their machine, then retry once.",
                file=sys.stderr,
            )
        return 0 if result.get("ok") else 2
    elif cmd == "exec":
        command = " ".join(rest)
        result = call("/exec", "POST", {"command": command})
        print(result.get("stdout", ""), end="")
        if result.get("stderr"):
            print(result["stderr"], file=sys.stderr, end="")
        return 0 if result.get("ok") else 2
    else:
        print(__doc__)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
