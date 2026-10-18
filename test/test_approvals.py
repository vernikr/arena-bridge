import atexit
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest


_temp = tempfile.TemporaryDirectory(prefix="arena-approvals-")
_home = Path(_temp.name)
_previous_home = os.environ.get("ARENA_BRIDGE_HOME")
os.environ["ARENA_BRIDGE_HOME"] = str(_home)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def cleanup():
    _temp.cleanup()
    if _previous_home is None:
        os.environ.pop("ARENA_BRIDGE_HOME", None)
    else:
        os.environ["ARENA_BRIDGE_HOME"] = _previous_home


atexit.register(cleanup)

from arena_bridge.approvals import decide, list_approvals, request_approval, settle
from arena_bridge.config import approvals_dir, config_dir, ensure_dirs
from arena_bridge.trust import trust_path

assert config_dir() == _home
assert approvals_dir() == _home / "approvals"
assert trust_path() == _home / "trust.json"
ensure_dirs()


def read(approval_id):
    return json.loads((approvals_dir() / f"{approval_id}.json").read_text())


def seed(approval_id, expired=True):
    now = int(time.time() * 1000)
    rec = dict(id=approval_id, tool="shell", args={}, status="pending",
               createdAt=now - 2000, expiresAt=now + (-1000 if expired else 900000),
               decidedAt=None, decidedBy=None)
    (approvals_dir() / f"{approval_id}.json").write_text(json.dumps(rec))


class ApprovalsTests(unittest.TestCase):
    def assert_system_decision(self, rec, status):
        self.assertEqual(rec["status"], status)
        self.assertEqual(rec["decidedBy"], "system")
        self.assertIsInstance(rec["decidedAt"], int)
        self.assertGreaterEqual(rec["decidedAt"], rec["createdAt"])

    def test_wait_zero_persists_timeout(self):
        result = request_approval("shell", {}, {"approvalWaitSec": 0, "approvalTtlSec": 900})
        self.assertFalse(result["approved"])
        self.assert_system_decision(result["rec"], "timeout")
        self.assertEqual(result["rec"]["expiresAt"] - result["rec"]["createdAt"], 900000)
        self.assertEqual(read(result["rec"]["id"]), result["rec"])

    def test_ttl_zero_returns_and_persists_expired(self):
        result = request_approval("shell", {}, {"approvalWaitSec": 0, "approvalTtlSec": 0})
        self.assertFalse(result["approved"])
        self.assertEqual(read(result["rec"]["id"]), result["rec"])
        self.assert_system_decision(result["rec"], "expired")

    def test_list_persists_expiry(self):
        seed("list-expired")
        rec = next(rec for rec in list_approvals() if rec["id"] == "list-expired")
        self.assert_system_decision(rec, "expired")
        self.assertEqual(read(rec["id"]), rec)

    def test_decide_rejects_expired_without_listing(self):
        seed("decide-expired")
        self.assertEqual(decide("decide-expired", "approve"),
                         {"ok": False, "error": "already expired"})
        self.assert_system_decision(read("decide-expired"), "expired")

    def test_settle_rejects_expired_without_creating_trust(self):
        seed("settle-expired")
        self.assertFalse(trust_path().exists())
        self.assertEqual(settle("settle-expired", "approve", "test", trust_sec=900),
                         {"ok": False, "error": "already expired"})
        self.assert_system_decision(read("settle-expired"), "expired")
        self.assertFalse(trust_path().exists())

    def assert_live_decision(self, decision, status):
        approval_id = f"live-{decision}"
        seed(approval_id, expired=False)
        result = decide(approval_id, decision, "test")
        self.assertTrue(result["ok"])
        self.assertEqual(result["approval"]["status"], status)
        self.assertEqual(result["approval"]["decidedBy"], "test")
        self.assertIsInstance(result["approval"]["decidedAt"], int)
        self.assertEqual(read(approval_id), result["approval"])

    def test_live_approve(self):
        self.assert_live_decision("approve", "approved")

    def test_live_deny(self):
        self.assert_live_decision("deny", "denied")


if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        cleanup()
