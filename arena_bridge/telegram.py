"""Telegram link: the bridge can message the user and read what they send back."""

import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from .config import config_dir, ensure_dirs

DEFAULT_BASE = "https://api.telegram.org"
MAX_TEXT = 4000
RATE_LIMIT = 20
RATE_WINDOW = 60.0


def current_config(cfg: dict) -> dict:
    """The configuration on disk wins, so a setup command takes effect at once."""
    try:
        from .config import load_config

        return load_config()
    except Exception:
        return cfg


def telegram_settings(cfg: dict) -> dict:
    t = cfg.get("telegram") or {}
    base_url = str(t.get("baseUrl") or os.environ.get("TELEGRAM_API_BASE") or DEFAULT_BASE).rstrip("/")
    return {
        "enabled": bool(t.get("enabled")) and bool(t.get("botToken")),
        "botToken": t.get("botToken"),
        "chatIds": [str(v) for v in (t.get("chatIds") or [])],
        "baseUrl": base_url,
        "poll": t.get("poll") is not False,
        "apiId": t.get("apiId"),
        "apiHash": t.get("apiHash"),
    }


def telegram_dir() -> Path:
    return config_dir() / "telegram"


def inbox_path() -> Path:
    return telegram_dir() / "inbox.jsonl"


def state_path() -> Path:
    return telegram_dir() / "state.json"


def _ensure_telegram_dir() -> None:
    ensure_dirs()
    telegram_dir().mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(telegram_dir(), 0o700)
    except OSError:
        pass


def _read_state() -> dict:
    try:
        return json.loads(state_path().read_text())
    except Exception:
        return {}


def _write_state(state: dict) -> None:
    _ensure_telegram_dir()
    state_path().write_text(json.dumps(state, indent=2) + "\n")
    try:
        os.chmod(state_path(), 0o600)
    except OSError:
        pass


def api_call(cfg: dict, method: str, payload: dict | None = None) -> dict:
    s = telegram_settings(cfg)
    if not s["botToken"]:
        return {
            "ok": False,
            "error": "telegram_not_configured",
            "reason": "no bot token in the configuration",
            "hint": "Run: arena-bridge telegram setup --token <bot token> --chat-id <your id>",
        }
    url = "{}/bot{}/{}".format(s["baseUrl"], s["botToken"], method)
    body = json.dumps(payload or {}).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=40) as res:
            data = json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            data = json.loads(e.read().decode("utf-8"))
        except Exception:
            data = None
        return {
            "ok": False,
            "error": "telegram_api_error",
            "reason": (data or {}).get("description") or str(e),
            "code": (data or {}).get("error_code"),
        }
    except Exception as e:
        return {"ok": False, "error": "telegram_unreachable", "reason": str(e)}
    if not data or data.get("ok") is not True:
        return {
            "ok": False,
            "error": "telegram_api_error",
            "reason": (data or {}).get("description") or "unknown error",
            "code": (data or {}).get("error_code"),
        }
    return {"ok": True, "result": data.get("result")}


def allowed_chat(cfg: dict, chat_id) -> bool:
    return str(chat_id) in telegram_settings(cfg)["chatIds"]


_sent_at = []


def _rate_ok(limit: int = RATE_LIMIT, window: float = RATE_WINDOW) -> bool:
    now = time.time()
    while _sent_at and now - _sent_at[0] > window:
        _sent_at.pop(0)
    if len(_sent_at) >= limit:
        return False
    _sent_at.append(now)
    return True


def send_telegram(cfg: dict, text: str = "", chat_id=None, title: str = "", silent: bool = False) -> dict:
    s = telegram_settings(cfg)
    if not s["enabled"]:
        return {
            "ok": False,
            "error": "telegram_not_configured",
            "reason": "Telegram is not configured for this bridge",
            "hint": "Run: arena-bridge telegram setup --token <bot token> --chat-id <your id>",
        }
    target = str(chat_id if chat_id is not None else (s["chatIds"][0] if s["chatIds"] else ""))
    if not target:
        return {"ok": False, "error": "telegram_no_chat", "reason": "no chat id configured"}
    if not allowed_chat(cfg, target):
        return {
            "ok": False,
            "error": "telegram_chat_not_allowed",
            "reason": "chat {} is not on the allow list".format(target),
        }
    body = str(text or "").strip()
    if not body:
        return {"ok": False, "error": "telegram_empty_message", "reason": "the message is empty"}
    if len(body) > MAX_TEXT:
        return {
            "ok": False,
            "error": "telegram_message_too_long",
            "reason": "the message is {} characters, the limit is {}".format(len(body), MAX_TEXT),
        }
    if not _rate_ok():
        return {
            "ok": False,
            "error": "telegram_rate_limited",
            "reason": "more than {} messages per minute".format(RATE_LIMIT),
        }
    payload = {"chat_id": target, "text": (title + "\n" + body) if title else body}
    if silent:
        payload["disable_notification"] = True
    res = api_call(cfg, "sendMessage", payload)
    if not res["ok"]:
        return res
    result = res.get("result") or {}
    return {
        "ok": True,
        "chat_id": (result.get("chat") or {}).get("id", target),
        "message_id": result.get("message_id"),
        "sent_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def append_inbox(item: dict) -> None:
    _ensure_telegram_dir()
    with open(inbox_path(), "a", encoding="utf-8") as fh:
        fh.write(json.dumps(item) + "\n")
    try:
        os.chmod(inbox_path(), 0o600)
    except OSError:
        pass


def read_inbox(limit: int = 20) -> list:
    try:
        raw = inbox_path().read_text()
    except Exception:
        return []
    read = set(str(v) for v in (_read_state().get("read") or []))
    items = []
    for line in raw.split("\n"):
        if not line.strip():
            continue
        try:
            items.append(json.loads(line))
        except Exception:
            continue
    out = items[-max(1, limit):]
    for item in out:
        item["read"] = str(item.get("id")) in read
    return out


def mark_inbox_read(ids) -> int:
    state = _read_state()
    read = set(str(v) for v in (state.get("read") or []))
    for i in ids or []:
        read.add(str(i))
    state["read"] = list(read)[-500:]
    _write_state(state)
    return len(state["read"])


def inbox_state() -> dict:
    state = _read_state()
    try:
        total = len([l for l in inbox_path().read_text().split("\n") if l.strip()])
    except Exception:
        total = 0
    read = set(str(v) for v in (state.get("read") or []))
    return {
        "total": total,
        "unread": max(0, total - len(read)),
        "bot": state.get("bot"),
        "offset": state.get("offset") or 0,
        "lastError": state.get("lastError"),
    }


def save_bot_info(info) -> None:
    state = _read_state()
    state["bot"] = info
    _write_state(state)


def parse_command(text) -> dict | None:
    raw = str(text or "").strip()
    if not raw.startswith("/"):
        return None
    parts = raw[1:].split()
    if not parts:
        return None
    return {"cmd": parts[0].lower(), "args": " ".join(parts[1:]).strip()}


def start_poller(cfg: dict, on_message=None):
    """Listen for incoming messages in a background thread."""
    s = telegram_settings(cfg)
    if not s["enabled"] or not s["poll"]:
        return None

    stop = threading.Event()

    def loop():
        cfg_now = current_config(cfg)
        if not _read_state().get("bot"):
            me = api_call(cfg_now, "getMe")
            if me.get("ok"):
                save_bot_info(me.get("result"))
        offset = _read_state().get("offset") or 0
        while not stop.is_set():
            try:
                cfg_now = current_config(cfg)
                res = api_call(cfg_now, "getUpdates", {"offset": offset, "timeout": 25, "allowed_updates": ["message"]})
                if not res.get("ok"):
                    state = _read_state()
                    state["lastError"] = res.get("reason") or res.get("error")
                    _write_state(state)
                    stop.wait(15 if res.get("code") == 409 else 5)
                    continue
                updates = res.get("result") or []
                if not updates:
                    stop.wait(0.4)
                    continue
                for upd in updates:
                    offset = upd.get("update_id", 0) + 1
                    state = _read_state()
                    state["offset"] = offset
                    _write_state(state)
                    msg = upd.get("message") or {}
                    if not msg:
                        continue
                    frm = msg.get("from") or {}
                    item = {
                        "id": upd.get("update_id"),
                        "chat_id": (msg.get("chat") or {}).get("id"),
                        "from": frm.get("username") or frm.get("first_name") or "unknown",
                        "text": msg.get("text") or "",
                        "date": msg.get("date"),
                        "read": False,
                    }
                    append_inbox(item)
                    if on_message:
                        try:
                            on_message(item)
                        except Exception:
                            pass
            except Exception:
                stop.wait(5)

    thread = threading.Thread(target=loop, daemon=True)
    thread.start()
    return {"stop": stop.set, "thread": thread}


def _wait_for_reply(cfg: dict, since_id: int, timeout_sec: int):
    deadline = time.time() + max(1, timeout_sec)
    while time.time() < deadline:
        for item in read_inbox(limit=20):
            if int(item.get("id") or 0) > since_id:
                return item
        time.sleep(0.5)
    return None


def telegram_tools(cfg: dict) -> list:
    def schema(props: dict) -> dict:
        return {"type": "object", "properties": props, "required": [], "additionalProperties": False}

    def notify_user(args, ctx):
        c = current_config(getattr(ctx, "cfg", None) or cfg)
        sent = send_telegram(
            c,
            text=args.get("text"),
            chat_id=args.get("chat_id"),
            title=args.get("title") or "",
            silent=bool(args.get("silent")),
        )
        if not sent.get("ok"):
            return sent
        if not args.get("wait_for_reply"):
            return sent
        ids = [int(i.get("id") or 0) for i in read_inbox(limit=50)]
        since = max(ids) if ids else 0
        reply = _wait_for_reply(c, since, min(600, int(args.get("timeout_sec") or 120)))
        if reply is None:
            out = dict(sent)
            out.update(
                {
                    "reply": None,
                    "timed_out": True,
                    "hint": "The user did not answer in Telegram. Continue without the answer or ask again later.",
                }
            )
            return out
        mark_inbox_read([reply.get("id")])
        out = dict(sent)
        out["reply"] = {"from": reply.get("from"), "text": reply.get("text"), "at": reply.get("date")}
        return out

    def telegram_inbox(args, ctx):
        limit = min(100, int(args.get("limit") or 20))
        items = read_inbox(limit)
        if args.get("mark_read") is not False and items:
            mark_inbox_read([i.get("id") for i in items])
        return {"ok": True, "count": len(items), "messages": items}

    def telegram_status(args, ctx):
        c = current_config(getattr(ctx, "cfg", None) or cfg)
        s = telegram_settings(c)
        if not s["enabled"]:
            return {
                "ok": False,
                "error": "telegram_not_configured",
                "reason": "Telegram is not configured for this bridge",
                "hint": "Run: arena-bridge telegram setup --token <bot token> --chat-id <your id>",
            }
        st = inbox_state()
        bot = st.get("bot") or {}
        return {
            "ok": True,
            "bot": ("@" + bot["username"]) if bot.get("username") else None,
            "bot_name": bot.get("first_name"),
            "chat_ids": s["chatIds"],
            "total_messages": st["total"],
            "unread": st["unread"],
            "polling": s["poll"],
            "last_error": st.get("lastError"),
        }

    return [
        {
            "name": "notify_user",
            "description": (
                "Send a message to the user in Telegram. Use it to report progress, ask a question, or hand over "
                "a result without waiting for the chat. Set wait_for_reply to keep the call open until the user "
                "answers in Telegram."
            ),
            "approval": False,
            "schema": schema(
                {
                    "text": {"type": "string", "description": "the message text (up to 4000 characters)"},
                    "title": {"type": "string", "description": "short first line, e.g. \"Готово\" or \"Нужен ответ\""},
                    "chat_id": {"type": "string", "description": "target chat id (default: the configured one)"},
                    "silent": {"type": "boolean", "description": "send without a sound"},
                    "wait_for_reply": {"type": "boolean", "description": "wait for the user to answer in Telegram"},
                    "timeout_sec": {"type": "number", "description": "how long to wait for a reply (default 120, max 600)"},
                }
            ),
            "required": ["text"],
            "handler": notify_user,
        },
        {
            "name": "telegram_inbox",
            "description": (
                "Read the messages the user sent in Telegram. Use it to pick up an answer, a file name or a "
                "command given outside the agent chat."
            ),
            "approval": False,
            "schema": schema(
                {
                    "limit": {"type": "number", "description": "how many messages to return (default 20)"},
                    "mark_read": {"type": "boolean", "description": "mark the returned messages as read (default true)"},
                }
            ),
            "required": [],
            "handler": telegram_inbox,
        },
        {
            "name": "telegram_status",
            "description": "Show the Telegram link: the bot, the allowed chats and how many messages are unread.",
            "approval": False,
            "schema": schema({}),
            "required": [],
            "handler": telegram_status,
        },
    ]
