import atexit, json, os, tempfile, pathlib, unittest
from pathlib import Path

_temp = tempfile.TemporaryDirectory(prefix="arena-sec-")
_home = Path(_temp.name)
_prev = os.environ.get("ARENA_BRIDGE_HOME")
os.environ["ARENA_BRIDGE_HOME"] = str(_home)

def cleanup():
    _temp.cleanup()
    if _prev is None:
        os.environ.pop("ARENA_BRIDGE_HOME", None)
    else:
        os.environ["ARENA_BRIDGE_HOME"] = _prev
atexit.register(cleanup)

from arena_bridge.config import load_config, defaults
from arena_bridge.engine import Engine
from arena_bridge.policy import check_path
from arena_bridge.telegram import allowed_chat

work = Path(tempfile.mkdtemp(prefix="arena-work-"))
outside = Path(tempfile.mkdtemp(prefix="arena-outside-"))
atexit.register(lambda: [__import__('shutil').rmtree(str(work), ignore_errors=True), __import__('shutil').rmtree(str(outside), ignore_errors=True)])

cfg = defaults()
cfg["roots"] = [str(work)]
cfg["protected"] = [str(work / "protected")]
cfg["allowShell"] = True
cfg["requireApproval"] = False
cfg["telegram"] = {"enabled": True, "botToken": "test", "chatIds": [123], "poll": False}
(work / "protected").mkdir(parents=True, exist_ok=True)
(work / "protected" / "secret.txt").write_text("secret")
# R1 fix: persist cfg to disk so Engine.call load_config() sees correct roots
from arena_bridge.config import save_config
save_config(cfg)

class SecurityTests(unittest.TestCase):
    def test_s1_audit_artifact_traversal(self):
        from arena_bridge.audit import read_artifact
        self.assertIsNone(read_artifact("/etc", "passwd"))
        self.assertIsNone(read_artifact("../../etc", "passwd"))

    def test_s2_list_dir_respects_protected(self):
        engine = Engine(cfg, base=str(work))
        (work / "ok.txt").write_text("ok")
        res = engine.call("list_dir", {"path": str(work)})
        self.assertTrue(res["ok"])
        paths = [e["path"] for e in res.get("entries", [])]
        # protected/secret.txt should not be listed
        self.assertFalse(any("protected/secret.txt" in p for p in paths))

    def test_s2b_dangling_symlink(self):
        link = work / "link"
        try: link.unlink()
        except: pass
        (outside / "secret.txt").write_text("outside")
        try:
            link.symlink_to(outside / "secret.txt")
        except:
            self.skipTest("symlink not supported")
        chk = check_path(str(link), cfg, base=str(work))
        self.assertFalse(chk[0], "dangling symlink outside roots should be blocked")
        try: link.unlink()
        except: pass

    def test_s4_allowed_chat(self):
        cfg_local = {"telegram": {"chatIds": [123, 456]}}
        self.assertTrue(allowed_chat(cfg_local, 123))
        self.assertFalse(allowed_chat(cfg_local, 999))

    def test_b2_redact_not_mask_mac_key(self):
        from arena_bridge.approvals import _redact
        self.assertEqual(_redact({"key": "cmd+q"})["key"], "cmd+q")
        self.assertEqual(_redact({"token": "abc"})["token"], "***")
        self.assertEqual(_redact({"env": {"secret": "y", "key": "x"}})["env"]["secret"], "***")

    def test_r3_edit_file_dollar(self):
        engine = Engine(cfg, base=str(work))
        f = work / "edit_test.txt"
        f.write_text("hello world")
        res = engine.call("edit_file", {"path": str(f), "old_text": "world", "new_text": "foo$&bar$$baz"})
        self.assertTrue(res["ok"], res)
        self.assertEqual(f.read_text(), "hello foo$&bar$$baz")

    def test_s7_limit_abc(self):
        engine = Engine(cfg, base=str(work))
        res = engine.call("audit_log", {"limit": "abc"})
        self.assertTrue(res["ok"])

    def test_b6_timing_safe(self):
        # S6: token compare should use compare_digest, not ==
        # We test that hub and server use compare_digest by checking import
        import arena_bridge.server as srv
        import inspect
        src = inspect.getsource(srv)
        self.assertIn("compare_digest", src)

if __name__ == "__main__":
    unittest.main()
