"""The Telegram link on the Python side: messages out, answers in, approvals from the chat."""

import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

HOME = Path(tempfile.mkdtemp(prefix="ab-py-tg-"))
os.environ["ARENA_BRIDGE_HOME"] = str(HOME)

from arena_bridge.config import defaults, save_config  # noqa: E402
from arena_bridge.engine import Engine  # noqa: E402
from arena_bridge import telegram as tg  # noqa: E402

WORK = HOME / "work"
WORK.mkdir(parents=True)

# ---------------------------------------------------------------- fake bot api

SENT = []
QUEUE = []


class FakeBot(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        payload = json.loads(self.rfile.read(length) or b"{}")
        method = self.path.rsplit("/", 1)[-1]
        if method == "getMe":
            body = {"ok": True, "result": {"id": 1, "username": "bridge_test_bot", "first_name": "Bridge"}}
        elif method == "sendMessage":
            SENT.append(payload)
            body = {"ok": True, "result": {"message_id": len(SENT), "chat": {"id": int(payload.get("chat_id", 0))}}}
        elif method == "getUpdates":
            body = {"ok": True, "result": QUEUE.pop(0) if QUEUE else []}
        else:
            body = {"ok": False, "error_code": 404, "description": "unknown method"}
        raw = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


server = ThreadingHTTPServer(("127.0.0.1", 0), FakeBot)
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = "http://127.0.0.1:{}".format(server.server_address[1])

cfg = defaults()
cfg.update(
    {
        "token": "test-token",
        "deviceToken": "device-token",
        "localToken": "local-token",
        "roots": [str(WORK)],
        "requireApproval": False,
        "approvalWaitSec": 2,
        "telegram": {
            "enabled": True,
            "botToken": "test-bot-token",
            "chatIds": ["42"],
            "poll": False,
            "baseUrl": BASE,
        },
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


print("\n▸ telegram")


@test("the catalog carries the telegram tools")
def _():
    names = [t["name"] for t in engine.catalog()]
    assert "notify_user" in names
    assert "telegram_inbox" in names
    assert "telegram_status" in names


@test("notify_user sends a message to the configured chat")
def _():
    before = len(SENT)
    r = engine.call("notify_user", {"text": "готово, всё сделал", "title": "Отчёт"})
    assert r["ok"], r
    assert len(SENT) == before + 1
    assert SENT[-1]["chat_id"] == "42"
    assert "готово" in SENT[-1]["text"]
    assert "Отчёт" in SENT[-1]["text"]


@test("a chat outside the allow list is refused")
def _():
    r = engine.call("notify_user", {"text": "привет", "chat_id": "999"})
    assert r["ok"] is False
    assert r["error"] == "telegram_chat_not_allowed"


@test("an empty message is refused")
def _():
    r = engine.call("notify_user", {"text": "   "})
    assert r["ok"] is False
    assert r["error"] == "telegram_empty_message"


@test("a message that is too long is refused")
def _():
    r = engine.call("notify_user", {"text": "x" * 5000})
    assert r["ok"] is False
    assert r["error"] == "telegram_message_too_long"


@test("telegram_inbox returns the messages the user sent")
def _():
    tg.append_inbox({"id": 11, "chat_id": 42, "from": "me", "text": "да, продолжай", "date": 1})
    r = engine.call("telegram_inbox", {})
    assert r["ok"], r
    assert r["count"] == 1
    assert r["messages"][0]["text"] == "да, продолжай"
    again = engine.call("telegram_inbox", {})
    assert again["messages"][0]["read"] is True


@test("telegram_status reports the link")
def _():
    r = engine.call("telegram_status", {})
    assert r["ok"], r
    assert r["chat_ids"] == ["42"]
    assert isinstance(r["unread"], int)


@test("an unconfigured bridge says so instead of failing silently")
def _():
    save_config({**cfg, "telegram": {"enabled": False, "botToken": None, "chatIds": []}})
    r = engine.call("notify_user", {"text": "привет"})
    save_config(cfg)
    assert r["ok"] is False
    assert r["error"] == "telegram_not_configured"
    assert "telegram setup" in r["hint"]


@test("a chat command is parsed")
def _():
    assert tg.parse_command("/approve 1234") == {"cmd": "approve", "args": "1234"}
    assert tg.parse_command("/deny") == {"cmd": "deny", "args": ""}
    assert tg.parse_command("привет") is None


@test("a pending approval is announced in Telegram")
def _():
    before = len(SENT)
    gate = Engine({**cfg, "requireApproval": True, "approvalWaitSec": 2}, base=str(WORK))
    r = gate.call("bash", {"command": "echo hi"})
    assert r["ok"] is False
    assert r["error"] == "APPROVAL_PENDING"
    assert len(SENT) == before + 1, "the user is told about the request"
    assert "/approve" in SENT[-1]["text"]


@test("the audit log masks credentials")
def _():
    from arena_bridge.audit import audit, tail_audit

    audit(
        {
            "tool": "bash",
            "args": {
                "command": "curl https://api.telegram.org/bot8605407779:AAHsu4ZpVVrkpzjKD7Em1I-U55Zcd9ndVPY/getMe"
            },
        }
    )
    last = tail_audit(1)[0]
    assert "bot***" in last["args"]["command"], last["args"]["command"]
    assert "AAHsu" not in last["args"]["command"]


@test("the rate limit protects the chat from a flood")
def _():
    limited = None
    for i in range(30):
        r = engine.call("notify_user", {"text": f"спам {i}"})
        if not r["ok"] and r["error"] == "telegram_rate_limited":
            limited = r
            break
    assert limited is not None, "the flood is stopped"


server.shutdown()
print(f"\n{PASSED} passed, {FAILED} failed\n")
if FAILED:
    sys.exit(1)
