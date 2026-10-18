"""Desktop control (macOS via Peekaboo) + listing behaviour on the Python side."""

import os
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

HOME = Path(tempfile.mkdtemp(prefix="ab-py-mac-"))
os.environ["ARENA_BRIDGE_HOME"] = str(HOME)
os.environ["PEEKABOO_PATH"] = str(Path(__file__).resolve().parent / "fake-peekaboo.sh")
os.environ["FAKE_PEEKABOO_LOG"] = str(HOME / "peek.log")

from arena_bridge.config import defaults, load_config, save_config  # noqa: E402
from arena_bridge.engine import Engine  # noqa: E402

WORK = HOME / "work"
(WORK / "nested" / "deep").mkdir(parents=True)
(WORK / "top.txt").write_text("x")
(WORK / "nested" / "deep" / "inner.txt").write_text("y")
(WORK / ".hidden").write_text("z")

cfg = defaults()
cfg.update(
    {
        "token": "test-token",
        "deviceToken": "device-token",
        "localToken": "local-token",
        "roots": [str(WORK)],
        "requireApproval": False,
        "approvalWaitSec": 2,
    }
)
save_config(cfg)
engine = Engine(cfg, base=str(WORK))

PASSED = 0
FAILED = 0


def test(name):
    def wrap(fn):
        global PASSED, FAILED
        try:
            fn()
            PASSED += 1
            print(f"  ✓ {name}")
        except Exception as exc:  # noqa: BLE001
            FAILED += 1
            print(f"  ✗ {name}\n      {exc}")
        return fn

    return wrap


print("\n▸ listing")


@test("list_dir returns the top level only by default")
def _():
    r = engine.call("list_dir", {"path": str(WORK)})
    assert r["ok"], r
    assert r["depth"] == 0
    names = sorted(e["name"] for e in r["entries"])
    assert names == [".hidden", "nested", "top.txt"], names
    assert all(e["depth"] == 0 for e in r["entries"])


@test("list_dir walks deeper when asked to")
def _():
    r = engine.call("list_dir", {"path": str(WORK), "recursive": True})
    paths = [e["path"] for e in r["entries"]]
    assert any(p.endswith(os.path.join("nested", "deep", "inner.txt")) for p in paths), paths
    assert any(e["depth"] == 2 for e in r["entries"])


@test("list_dir can hide dotfiles")
def _():
    r = engine.call("list_dir", {"path": str(WORK), "include_hidden": False})
    assert not any(e["name"] == ".hidden" for e in r["entries"])


print("\n▸ desktop control")


@test("the catalog carries the mac_* tools")
def _():
    names = {t["name"] for t in engine.catalog()}
    for t in ("mac_see", "mac_click", "mac_type", "mac_key", "mac_apps", "mac_windows"):
        assert t in names, f"missing {t}"


@test("mac_see captures a screenshot and lists the elements")
def _():
    r = engine.call("mac_see", {"path": str(WORK / "shot.png")})
    assert r["ok"], r
    assert r["saved"] is True
    assert r["element_count"] == 2
    assert r["elements"][0]["id"] == "B1"
    assert (WORK / "shot.png").exists()


@test("mac_click passes the element id to peekaboo")
def _():
    r = engine.call("mac_click", {"on": "B1", "app": "Safari"})
    assert r["ok"], r
    log = (HOME / "peek.log").read_text()
    assert "click --on B1 --app Safari" in log


@test("mac_type and mac_key reach the desktop")
def _():
    assert engine.call("mac_type", {"text": "hello"})["ok"]
    assert engine.call("mac_key", {"key": "cmd+s"})["ok"]
    log = (HOME / "peek.log").read_text()
    assert "type hello" in log
    assert "press cmd+s" in log


@test("mac_apps and mac_windows return structured lists")
def _():
    apps = engine.call("mac_apps", {})
    assert apps["ok"], apps
    assert apps["apps"][0]["name"] == "Safari"
    wins = engine.call("mac_windows", {})
    assert wins["ok"], wins
    assert wins["windows"][0]["id"] == 42


@test("mac_windows enumerates the windows of the running apps")
def _():
    r = engine.call("mac_windows", {})
    assert r["ok"], r
    assert r["windows"][0]["title"] == "Documents"
    assert r["windows"][0]["app"] == "Safari"


@test("mac_element finds controls by their visible name")
def _():
    r = engine.call("mac_element", {"name": "Save"})
    assert r["ok"], r
    assert r["count"] == 1
    assert r["matches"][0]["id"] == "B1"
    assert r["matches"][0]["role"] == "button"


@test("mac_element can filter by role")
def _():
    r = engine.call("mac_element", {"role": "textField"})
    assert r["count"] == 1
    assert r["matches"][0]["title"] == "Search"


@test("mac_set writes a value through the accessibility API")
def _():
    r = engine.call("mac_set", {"on": "B2", "value": "hello"})
    assert r["ok"], r
    assert "set-value hello --on B2" in (HOME / "peek.log").read_text()


@test("mac_menu lists and clicks menu items by name")
def _():
    listing = engine.call("mac_menu", {"app": "Safari"})
    assert listing["ok"], listing
    assert listing["menus"][0]["title"] == "File"
    click = engine.call("mac_menu_click", {"item": "Save", "app": "Safari"})
    assert click["ok"], click
    assert "menu click --item Save --app Safari" in (HOME / "peek.log").read_text()


@test("mac_spaces shows the virtual desktops")
def _():
    r = engine.call("mac_spaces", {})
    assert r["ok"], r
    assert r["spaces"][1]["id"] == 2
    assert r["spaces"][0]["is_active"] is True
    switch = engine.call("mac_space_switch", {"to": "2"})
    assert switch["ok"], switch
    assert "space switch --to 2" in (HOME / "peek.log").read_text()


@test("mac_wait reports the element it waited for")
def _():
    r = engine.call("mac_wait", {"name": "Save", "timeout": 5})
    assert r["ok"], r
    assert r["found"] is True
    assert r["element"]["id"] == "B1"


@test("mac_wait can wait for something to disappear")
def _():
    r = engine.call("mac_wait", {"name": "Nothing here", "disappear": True, "timeout": 5})
    assert r["ok"], r
    assert r["gone"] is True


@test("a screenshot and the accessibility tree are kept as artifacts")
def _():
    r = engine.call("mac_see", {"path": str(WORK / "shot2.png")})
    assert r["ok"], r
    log = engine.call("audit_log", {"tool": "mac_see", "limit": 10})
    entry = next((e for e in log["entries"] if e.get("tool") == "mac_see" and e.get("artifacts")), None)
    assert entry, "the log entry carries artifacts"
    names = [a["name"] for a in entry["artifacts"]]
    assert "screen.png" in names, names
    assert "ax-tree.json" in names, names
    tree = engine.call("audit_artifact", {"entry": entry["id"], "file": "ax-tree.json"})
    assert tree["ok"], tree
    assert tree["content"]["data"]["ui_elements"], "the tree is readable"
    shot = engine.call("audit_artifact", {"entry": entry["id"], "file": "screen.png"})
    assert shot["kind"] == "image"
    assert len(shot["image_base64"]) > 0


@test("the artifact of a call is listed with its size")
def _():
    log = engine.call("audit_log", {"limit": 20})
    assert log["ok"], log
    with_artifacts = [e for e in log["entries"] if e.get("artifacts")]
    assert with_artifacts, "at least one entry has artifacts"
    assert with_artifacts[0]["artifacts"][0]["bytes"] > 0


@test("the local runtime is used when the bridge host has no permissions")
def _():
    r = engine.call("mac_see", {"path": str(WORK / "shot3.png")})
    assert r["ok"], r
    assert r["element_count"] == 2, "the elements come from the local runtime"
    assert "--no-remote" in (HOME / "peek.log").read_text()


@test("a permission problem is reported with a clear hint")
def _():
    os.environ["FAKE_PEEKABOO_NO_PERMS"] = "1"
    try:
        r = engine.call("mac_see", {"path": str(WORK / "shot4.png")})
    finally:
        del os.environ["FAKE_PEEKABOO_NO_PERMS"]
    assert r["ok"] is False
    assert r["error"] == "peekaboo_failed"
    assert "permission" in r["reason"].lower()
    assert "Screen Recording" in r["hint"]


@test("a missing peekaboo is reported instead of crashing")
def _():
    saved = os.environ["PEEKABOO_PATH"]
    os.environ["PEEKABOO_PATH"] = "/nonexistent/peekaboo"
    cfg2 = dict(load_config())
    cfg2["peekabooPath"] = "/nonexistent/peekaboo"
    engine2 = Engine(cfg2, base=str(WORK))
    r = engine2.call("mac_see", {"path": str(WORK / "x.png")})
    assert r["ok"] is False
    assert r["error"] == "peekaboo_not_found"
    os.environ["PEEKABOO_PATH"] = saved


print("\n▸ approvals")


@test("a pending approval is reported clearly instead of hanging")
def _():
    save_config({**cfg, "requireApproval": True, "approvalWaitSec": 1})
    engine3 = Engine(load_config(), base=str(WORK))
    r = engine3.call("mac_click", {"on": "B1"})
    assert r["ok"] is False
    assert r["error"] == "APPROVAL_PENDING"
    assert r["pending"] is True
    assert r["approval_id"]
    save_config(cfg)


shutil.rmtree(HOME, ignore_errors=True)
print(f"\n{PASSED} passed, {FAILED} failed\n")
sys.exit(1 if FAILED else 0)
