"""Browser stack tests for the Python implementation (uses the Node fake CDP server)."""

import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

TMP = Path(tempfile.mkdtemp(prefix="arena-bridge-py-browser-"))
os.environ["ARENA_BRIDGE_HOME"] = str(TMP / "home")
(TMP / "home").mkdir(parents=True, exist_ok=True)

from arena_bridge.cdp import CDPClient, browser_ws_url  # noqa: E402
from arena_bridge.config import defaults, save_config  # noqa: E402
from arena_bridge.engine import Engine  # noqa: E402
from arena_bridge.ws import WebSocketClient  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
FAKE = ROOT / "test" / "fake-cdp.mjs"
FAKE_CHROME = ROOT / "test" / "fake-chrome.sh"
os.chmod(FAKE_CHROME, 0o755)

PORT = 9500 + int(time.time() % 200)
fake = subprocess.Popen(["node", str(FAKE), "--port", str(PORT)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(60):
    time.sleep(0.1)
    try:
        browser_ws_url(PORT)
        break
    except Exception:
        pass

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


cfg = defaults()
cfg.update(
    {
        "token": "py-browser-token",
        "deviceToken": "py-browser-device",
        "localToken": "py-browser-local",
        "device": "browserbox",
        "roots": [str(TMP)],
        "protected": [str(TMP / "secret")],
        "requireApproval": False,
    }
)
save_config(cfg)
engine = Engine(cfg, str(TMP))

print("\n▸ websocket client")


@test("handshake and command round-trip")
def _():
    ws = WebSocketClient(f"ws://127.0.0.1:{PORT}/devtools/browser/fake").connect()
    ws.send('{"id":1,"method":"Target.getTargets"}')
    import json

    msg = json.loads(ws.recv())
    assert msg["id"] == 1
    assert len(msg["result"]["targetInfos"]) == 2
    ws.close()


@test("large payloads survive in both directions")
def _():
    import json

    ws = WebSocketClient(f"ws://127.0.0.1:{PORT}/devtools/browser/fake").connect()
    ws.send(json.dumps({"id": 2, "method": "Fake.large", "params": {"pad": "x" * 200000}}))
    msg = json.loads(ws.recv())
    assert len(msg["result"]["data"]) == 300000
    ws.close()


print("\n▸ cdp client")


@test("send() resolves with the command result")
def _():
    cdp = CDPClient(f"ws://127.0.0.1:{PORT}/devtools/browser/fake").connect()
    res = cdp.send("Target.getTargets")
    assert res["targetInfos"][0]["url"] == "https://example.com/"
    cdp.close()


print("\n▸ browser tools")


@test("the catalog exposes the chrome_* tools")
def _():
    names = [t["name"] for t in engine.catalog()]
    for n in [
        "chrome_launch",
        "chrome_attach",
        "chrome_tabs",
        "chrome_open",
        "chrome_navigate",
        "chrome_snapshot",
        "chrome_click",
        "chrome_type",
        "chrome_press",
        "chrome_screenshot",
        "chrome_evaluate",
        "chrome_stop",
    ]:
        assert n in names, f"missing tool {n}"


@test("chrome_launch starts an agent-owned browser and lists its tabs")
def _():
    os.environ["CHROME_PATH"] = str(FAKE_CHROME)
    res = engine.call("chrome_launch", {"headless": True, "port": PORT + 1})
    assert res["ok"] is True, res
    assert res["managed"] is True
    assert len(res["tabs"]) >= 2
    engine.browser.sessions[res["session_id"]]["proc"].terminate()


@test("actions on the agent-owned browser need no approval")
def _():
    os.environ["CHROME_PATH"] = str(FAKE_CHROME)
    launch = engine.call("chrome_launch", {"headless": True, "port": PORT + 2})
    session = launch["session_id"]
    opened = engine.call("chrome_open", {"session_id": session, "url": "https://example.net/"})
    assert opened["ok"] is True, opened
    snap = engine.call("chrome_snapshot", {"session_id": session, "tab_id": opened["tab_id"]})
    assert snap["text"] == "Hello from the fake page", snap
    engine.browser.sessions[session]["proc"].terminate()


@test("chrome_snapshot returns an accessibility tree in ax mode")
def _():
    os.environ["CHROME_PATH"] = str(FAKE_CHROME)
    launch = engine.call("chrome_launch", {"headless": True, "port": PORT + 3})
    snap = engine.call("chrome_snapshot", {"session_id": launch["session_id"], "mode": "ax"})
    assert any(n["name"] == "Submit" for n in snap["nodes"]), snap
    engine.browser.sessions[launch["session_id"]]["proc"].terminate()


@test("chrome_screenshot saves a PNG inside the authorized roots")
def _():
    os.environ["CHROME_PATH"] = str(FAKE_CHROME)
    launch = engine.call("chrome_launch", {"headless": True, "port": PORT + 4})
    target = TMP / "shot.png"
    shot = engine.call("chrome_screenshot", {"session_id": launch["session_id"], "path": str(target)})
    assert shot["ok"] is True, shot
    assert target.exists()
    assert target.read_bytes()[:1] == b"\x89"
    engine.browser.sessions[launch["session_id"]]["proc"].terminate()


@test("chrome_screenshot refuses paths outside the authorized roots")
def _():
    os.environ["CHROME_PATH"] = str(FAKE_CHROME)
    launch = engine.call("chrome_launch", {"headless": True, "port": PORT + 5})
    shot = engine.call("chrome_screenshot", {"session_id": launch["session_id"], "path": "/etc/passwd"})
    assert shot["ok"] is False
    assert shot["error"] == "PROTECTED"
    engine.browser.sessions[launch["session_id"]]["proc"].terminate()


@test("actions on the user's own Chrome require a local approval")
def _():
    attach = engine.call("chrome_attach", {"port": PORT})
    assert attach["ok"] is True, attach
    assert attach["managed"] is False
    blocked = engine.call(
        "chrome_click", {"session_id": attach["session_id"], "text": "Submit"}, require_approval=True
    )
    assert blocked["ok"] is False
    assert blocked["error"] == "APPROVAL_PENDING"
    engine.browser.sessions[attach["session_id"]]["cdp"].close()


@test("chrome_stop refuses to kill an attached user browser")
def _():
    attach = engine.call("chrome_attach", {"port": PORT})
    stopped = engine.call("chrome_stop", {"session_id": attach["session_id"]})
    assert stopped["ok"] is False
    engine.browser.sessions[attach["session_id"]]["cdp"].close()


fake.kill()
print(f"\n{PASSED} passed, {FAILED} failed\n")
shutil.rmtree(TMP, ignore_errors=True)
sys.exit(1 if FAILED else 0)
