"""End-to-end test for the Python implementation.

Run with: python3 test/test_bridge.py
"""

import json
import os
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

TMP = Path(tempfile.mkdtemp(prefix="arena-bridge-py-"))
os.environ["ARENA_BRIDGE_HOME"] = str(TMP / "home")
(TMP / "home").mkdir(parents=True, exist_ok=True)

from arena_bridge.approvals import decide, list_approvals  # noqa: E402
from arena_bridge.config import defaults, save_config, config_dir  #noqa: E402
from arena_bridge.device import run_device  # noqa: E402
from arena_bridge.engine import Engine  # noqa: E402
from arena_bridge.hub import serve as serve_hub  # noqa: E402
from arena_bridge.server import serve as serve_direct  # noqa: E402

WORK = TMP / "work"
WORK.mkdir()
(WORK / "hello.txt").write_text("hello world\n")
(TMP / "secret").mkdir()
(TMP / "secret" / "key.pem").write_text("PRIVATE")

PASSED = 0
FAILED = 0


def test(name):
    def deco(fn):
        global PASSED, FAILED
        try:
            fn()
            PASSED += 1
            print(f"  ✓ {name}")
        except Exception as e:  # noqa: BLE001
            FAILED += 1
            print(f"  ✗ {name}\n      {type(e).__name__}: {e}")
        return fn

    return deco


def request(url, method="GET", token=None, body=None, raw=None, headers=None):
    hdrs = dict(headers or {})
    if token:
        hdrs["Authorization"] = f"Bearer {token}"
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    elif raw is not None:
        data = raw
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = resp.read()
            return resp.status, payload
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def json_request(url, method="GET", token=None, body=None):
    status, payload = request(url, method=method, token=token, body=body)
    try:
        return status, json.loads(payload.decode())
    except Exception:
        return status, payload.decode(errors="replace")


cfg = defaults()
cfg.update(
    {
        "mode": "direct",
        "host": "127.0.0.1",
        "port": 0,
        "token": "test-agent-token",
        "deviceToken": "test-device-token",
        "device": "testbox",
        "roots": [str(WORK)],
        "protected": [str(TMP / "secret")],
        "requireApproval": False,
        "approvalWaitSec": 5,
    }
)
save_config(cfg)

engine = Engine(cfg, str(WORK))
server = serve_direct(cfg, engine)  # port 0 -> the OS picks a free port
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()
time.sleep(0.2)
base = f"http://127.0.0.1:{port}"
auth = "test-agent-token"


@test("policy, files API and config endpoint reload without restarting")
def _():
    other = TMP / "other"
    other.mkdir(exist_ok=True)
    (other / "x.txt").write_text("x")
    live = dict(cfg)
    live["roots"] = [str(WORK), str(other)]
    save_config(live)
    try:
        status, j = json_request(f"{base}/call", "POST", auth, {"tool": "read_file", "args": {"path": str(other / "x.txt")}})
        assert status == 200 and j["ok"] is True, (status, j)
        status, payload = request(f"{base}/files?path={urllib.parse.quote(str(other / 'x.txt'))}", token=auth)
        assert status == 200 and payload == b"x", (status, payload)
        status, current = json_request(f"{base}/config", token=auth)
        assert status == 200 and str(other.resolve()) in current["roots"], (status, current)
    finally:
        save_config(cfg)

print("\n▸ direct mode")


@test("GET /health works without auth")
def _():
    status, j = json_request(f"{base}/health")
    assert status == 200 and j["ok"] is True


@test("GET /tools requires auth")
def _():
    status, _ = json_request(f"{base}/tools")
    assert status == 401


@test("GET /tools returns the catalog")
def _():
    status, j = json_request(f"{base}/tools", token=auth)
    assert status == 200 and len(j["tools"]) >= 14


@test("a rotated token takes effect without restarting the server")
def _():
    from arena_bridge.config import load_config

    live = load_config()
    live["token"] = "rotated-token-xyz"
    save_config(live)
    status, _ = json_request(f"{base}/tools", token=auth)
    assert status == 401, "the old token must stop working immediately"
    status, _ = json_request(f"{base}/tools", token="rotated-token-xyz")
    assert status == 200
    save_config(cfg)


@test("read_file reads a file inside the root")
def _():
    status, j = json_request(
        f"{base}/call", "POST", auth, {"tool": "read_file", "args": {"path": str(WORK / "hello.txt")}}
    )
    assert j["ok"] is True, j
    assert j["content"] == "hello world\n"


@test("read_file outside the roots is PROTECTED")
def _():
    status, j = json_request(
        f"{base}/call", "POST", auth, {"tool": "read_file", "args": {"path": "/etc/hostname"}}
    )
    assert j["error"] == "PROTECTED", j


@test("read_file of a protected path is PROTECTED")
def _():
    status, j = json_request(
        f"{base}/call", "POST", auth, {"tool": "read_file", "args": {"path": str(TMP / "secret" / "key.pem")}}
    )
    assert j["error"] == "PROTECTED", j


@test("bash executes a command")
def _():
    status, j = json_request(f"{base}/exec", "POST", auth, {"command": "echo smoke-ok"})
    assert j["ok"] is True, j
    assert "smoke-ok" in j["stdout"]
    assert j["exit_code"] == 0


@test("files API supports GET/PUT/DELETE")
def _():
    target = str(WORK / "blob.bin")
    status, _ = request(f"{base}/files?path={target}", "PUT", auth, raw=b"binary-ish")
    assert status == 200
    status, payload = request(f"{base}/files?path={target}", "GET", auth)
    assert payload == b"binary-ish"
    status, _ = request(f"{base}/files?path={target}", "DELETE", auth)
    assert status == 200
    assert not (WORK / "blob.bin").exists()


@test("MCP initialize / tools/list / tools/call work")
def _():
    status, j = json_request(
        f"{base}/mcp", "POST", auth, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}
    )
    assert j["result"]["protocolVersion"] == "2025-06-18", j
    status, j = json_request(
        f"{base}/mcp", "POST", auth, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
    )
    assert len(j["result"]["tools"]) >= 14
    status, j = json_request(
        f"{base}/mcp",
        "POST",
        auth,
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "sysinfo", "arguments": {}}},
    )
    assert j["result"]["isError"] is False, j


@test("start_process + read_process_output work")
def _():
    status, j = json_request(
        f"{base}/call", "POST", auth, {"tool": "start_process", "args": {"command": "echo long-running"}}
    )
    assert j["ok"] is True, j
    sid = j["session_id"]
    status, j = json_request(
        f"{base}/call", "POST", auth, {"tool": "read_process_output", "args": {"session_id": sid, "timeout_sec": 3}}
    )
    assert "long-running" in j["stdout"], j

print("\n▸ approval gate")

cfg_ap = dict(cfg)
cfg_ap["requireApproval"] = True
cfg_ap["approvalWaitSec"] = 10
save_config(cfg_ap)
engine2 = Engine(cfg_ap, str(WORK))
server2 = serve_direct(cfg_ap, engine2)  # port 0
port2 = server2.server_address[1]
threading.Thread(target=server2.serve_forever, daemon=True).start()
time.sleep(0.2)
base2 = f"http://127.0.0.1:{port2}"


@test("side-effecting tool waits for a human approval")
def _():
    result = {}

    def worker():
        result["value"] = json_request(
            f"{base2}/call", "POST", auth, {"tool": "bash", "args": {"command": "echo approved-case"}}
        )

    t = threading.Thread(target=worker)
    t.start()
    pending = None
    for _ in range(40):
        time.sleep(0.2)
        pending = next((a for a in list_approvals() if a["status"] == "pending" and a["tool"] == "bash"), None)
        if pending:
            break
    assert pending is not None, "no pending approval created"
    assert decide(pending["id"], "approve", "test")["ok"] is True
    t.join(timeout=20)
    status, j = result["value"]
    assert j["ok"] is True, j
    assert "approved-case" in j["stdout"]


@test("denied approval blocks the tool")
def _():
    result = {}

    def worker():
        result["value"] = json_request(
            f"{base2}/call", "POST", auth, {"tool": "bash", "args": {"command": "echo denied-case"}}
        )

    t = threading.Thread(target=worker)
    t.start()
    pending = None
    for _ in range(40):
        time.sleep(0.2)
        pending = next((a for a in list_approvals() if a["status"] == "pending" and a["tool"] == "bash"), None)
        if pending:
            break
    assert pending is not None
    decide(pending["id"], "deny", "test")
    t.join(timeout=20)
    status, j = result["value"]
    assert j["ok"] is False and j["error"] == "APPROVAL_DENIED", j
    assert j["pending"] is False, j


@test("timed-out approvals are settled and cannot be approved later")
def _():
    cfg_timeout = dict(cfg_ap)
    cfg_timeout["approvalWaitSec"] = 1
    save_config(cfg_timeout)
    old_wait = engine2.cfg["approvalWaitSec"]
    engine2.cfg["approvalWaitSec"] = 1
    result = {}

    def worker():
        result["value"] = json_request(
            f"{base2}/call", "POST", auth, {"tool": "bash", "args": {"command": "echo timeout-case"}}
        )

    t = threading.Thread(target=worker)
    t.start()
    pending = None
    for _ in range(20):
        time.sleep(0.1)
        pending = next((a for a in list_approvals() if a["status"] == "pending" and a["tool"] == "bash"), None)
        if pending:
            break
    assert pending is not None
    t.join(timeout=5)
    status, j = result["value"]
    assert j["error"] == "APPROVAL_PENDING", j
    stored = next(a for a in list_approvals() if a["id"] == pending["id"])
    assert stored["status"] == "timeout"
    assert decide(pending["id"], "approve", "late-test")["ok"] is False
    engine2.cfg["approvalWaitSec"] = old_wait

print("\n▸ trust window")

from arena_bridge.trust import clear_trust, save_trust, trust_state  # noqa: E402

assert str(config_dir()).startswith(str(TMP)), "the test must not touch the real configuration"

save_config(cfg_ap)  # approvals on: only a trust window can lift them


@test("a symlinked root still matches its files")
def _():
    from arena_bridge.policy import check_path

    real = TMP / "real-root"
    link = TMP / "link-root"
    real.mkdir(parents=True, exist_ok=True)
    (real / "inside.txt").write_text("x")
    try:
        link.symlink_to(real, target_is_directory=True)
    except OSError:
        return
    ok, _, err, _ = check_path(str(link / "inside.txt"), {"roots": [str(link)], "protected": []})
    assert ok, err


@test("an open trust window removes the approval requirement")
def _():
    save_trust({"enabled": True, "until": int(time.time() * 1000) + 3600000, "tools": [], "paths": [], "createdAt": int(time.time() * 1000)})
    status, j = json_request(f"{base2}/call", "POST", auth, {"tool": "bash", "args": {"command": "echo trusted"}})
    assert j["ok"] is True, j
    assert "trusted" in j["stdout"]
    clear_trust()


@test("a tool-scoped trust window covers only the listed tools")
def _():
    save_trust({"enabled": True, "until": int(time.time() * 1000) + 3600000, "tools": ["write_file"], "paths": [], "createdAt": int(time.time() * 1000)})
    target = str(WORK / "trusted.txt")
    status, j = json_request(f"{base2}/call", "POST", auth, {"tool": "write_file", "args": {"path": target, "content": "ok"}})
    assert j["ok"] is True, j
    status, j = json_request(f"{base2}/call", "POST", auth, {"tool": "bash", "args": {"command": "echo nope"}})
    assert j["ok"] is False and j["error"] == "APPROVAL_PENDING", j
    clear_trust()


@test("a path-scoped trust window only covers paths inside it")
def _():
    inside = WORK / "inside"
    outside = WORK / "outside"
    inside.mkdir(exist_ok=True)
    outside.mkdir(exist_ok=True)
    save_trust({"enabled": True, "until": int(time.time() * 1000) + 3600000, "tools": [], "paths": [str(inside)], "createdAt": int(time.time() * 1000)})
    status, j = json_request(f"{base2}/call", "POST", auth, {"tool": "write_file", "args": {"path": str(inside / "a.txt"), "content": "x"}})
    assert j["ok"] is True, j
    status, j = json_request(f"{base2}/call", "POST", auth, {"tool": "write_file", "args": {"path": str(outside / "b.txt"), "content": "x"}})
    assert j["ok"] is False and j["error"] == "APPROVAL_PENDING", j
    clear_trust()


@test("an expired trust window no longer applies")
def _():
    save_trust({"enabled": True, "until": int(time.time() * 1000) - 1000, "tools": [], "paths": [], "createdAt": int(time.time() * 1000)})
    status, j = json_request(f"{base2}/call", "POST", auth, {"tool": "bash", "args": {"command": "echo expired"}})
    assert j["ok"] is False and j["error"] == "APPROVAL_PENDING", j
    clear_trust()


save_config(cfg)  # back to the default policy for the remaining tests

print("\n▸ hub mode")

hub_cfg = dict(cfg)
hub_cfg["mode"] = "hub"
hub_cfg["port"] = 0
hub = serve_hub(hub_cfg)  # port 0
hub_port = hub.server_address[1]
hub_cfg["hub"] = f"http://127.0.0.1:{hub_port}"
threading.Thread(target=hub.serve_forever, daemon=True).start()
time.sleep(0.2)

device_engine = Engine(hub_cfg, str(WORK))
threading.Thread(target=run_device, args=(hub_cfg, device_engine, lambda *a: None), daemon=True).start()
time.sleep(1.0)


@test("hub reports the device as online")
def _():
    status, j = json_request(f"{hub_cfg['hub']}/devices", token=auth)
    assert status == 200 and len(j["devices"]) == 1, j
    assert j["devices"][0]["online"] is True, j


@test("agent call is forwarded to the device and executed there")
def _():
    status, j = json_request(
        f"{hub_cfg['hub']}/call", "POST", auth, {"tool": "bash", "args": {"command": "echo from-device"}}
    )
    assert j["ok"] is True, j
    assert "from-device" in j["stdout"]


@test("device token cannot use the agent API")
def _():
    status, _ = json_request(
        f"{hub_cfg['hub']}/call", "POST", "test-device-token", {"tool": "bash", "args": {"command": "echo escalation"}}
    )
    assert status == 401


@test("hub rejects an unknown device")
def _():
    status, j = json_request(
        f"{hub_cfg['hub']}/call", "POST", auth, {"tool": "bash", "args": {"device": "ghost", "command": "echo nope"}}
    )
    assert j["ok"] is False and j["error"] == "DEVICE_OFFLINE", j


@test("a dropped tunnel is restarted and the new URL is reported")
def _():
    from arena_bridge.tunnel import start_tunnel

    log = TMP / "tunnel-restart.log"
    fake = TMP / "fake-flaky-tunnel"
    fake.write_text(
        "#!/bin/sh\n"
        f'echo "start $$" >> "{log}"\n'
        "echo '2026-01-01T00:00:00Z INF https://fake-flaky-tunnel.trycloudflare.com'\n"
        "exit 1\n"
    )
    fake.chmod(0o755)
    proc, box, event = start_tunnel(8787, "http2", str(fake), delay=0.1)
    assert event.wait(timeout=15), box
    assert box["url"] == "https://fake-flaky-tunnel.trycloudflare.com", box
    seen = []
    box["on_url"](seen.append)
    time.sleep(1.2)
    starts = len(log.read_text().strip().splitlines())
    assert starts >= 2, f"expected the tunnel to restart, got {starts} start(s)"
    assert seen, "the new URL is reported"
    proc.terminate()


@test("the app name is the same in node, python and swift")
def _():
    from arena_bridge.app import APP_ID, APP_NAME

    root = Path(__file__).resolve().parent.parent
    swift = (root / "macos/ArenaBridge/Sources/AppInfo.swift").read_text()
    assert 'static let name = "%s"' % APP_NAME in swift, swift
    assert 'static let bundleID = "%s"' % APP_ID in swift, swift


@test("only the ngrok of our own domain is stopped")
def _():
    from arena_bridge.tunnel import kill_stale_ngrok

    assert kill_stale_ngrok("no-such-domain-xyz.ngrok-free.dev") == []
    assert kill_stale_ngrok(None) == []


@test("the background service starts the app, not the python binary")
def _():
    from arena_bridge.app import APP_NAME
    from arena_bridge.service import runner_path

    assert runner_path().name == APP_NAME, runner_path()


@test("the service starts the helper of the app bundle when it is installed")
def _():
    import plistlib
    from arena_bridge.service import agent_path, program_arguments, service_payload

    bundle = TMP / "Arena Bridge.app"
    helper = bundle / "Contents" / "Helpers" / "arena-bridge-agent"
    helper.parent.mkdir(parents=True, exist_ok=True)
    (bundle / "Contents" / "Info.plist").write_text("<plist/>")
    helper.write_text("#!/bin/sh\nexit 0\n")
    helper.chmod(0o755)
    os.environ["ARENA_BRIDGE_APP"] = str(bundle)
    try:
        assert agent_path() == helper, agent_path()
        args = program_arguments(bin="ngrok", domain="x.ngrok-free.dev")
        assert args[0] == str(helper), args
        assert args[1:4] == [sys.executable, "-m", "arena_bridge"], args
        assert args[4] == "tunnel", args
        assert args[5:] == ["--bin", "ngrok", "--domain", "x.ngrok-free.dev"], args
        # the written plist holds the helper as the entry point
        plist = TMP / "agent.plist"
        with open(plist, "wb") as fh:
            plistlib.dump(service_payload(bin="ngrok"), fh)
        with open(plist, "rb") as fh:
            payload = plistlib.load(fh)
        assert payload["ProgramArguments"][0] == str(helper), payload["ProgramArguments"]
        assert payload["ProgramArguments"][1:4] == [
            sys.executable,
            "-m",
            "arena_bridge",
        ], payload["ProgramArguments"]
        assert payload["ProgramArguments"][4] == "tunnel", payload["ProgramArguments"]
        assert payload["ProgramArguments"][5:] == ["--bin", "ngrok"], payload["ProgramArguments"]
        assert payload["KeepAlive"] is True and payload["RunAtLoad"] is True, payload
    finally:
        os.environ.pop("ARENA_BRIDGE_APP", None)


@test("the service falls back to the wrapper without the app")
def _():
    from arena_bridge.service import agent_path, program_arguments, runner_path

    os.environ["ARENA_BRIDGE_APP"] = str(TMP / "no-such.app")
    try:
        assert agent_path() is None, agent_path()
        assert program_arguments() == [str(runner_path()), "tunnel"], program_arguments()
    finally:
        os.environ.pop("ARENA_BRIDGE_APP", None)


server.shutdown()
server2.shutdown()
hub.shutdown()
print(f"\n{PASSED} passed, {FAILED} failed\n")
shutil.rmtree(TMP, ignore_errors=True)
sys.exit(1 if FAILED else 0)
