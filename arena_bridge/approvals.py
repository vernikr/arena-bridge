import json
import re
import time
import uuid
from pathlib import Path

from .config import approvals_dir, ensure_dirs
from .telegram import send_telegram

_SECRET_RE = re.compile(r"token|secret|password|key", re.IGNORECASE)


def _file(approval_id: str) -> Path:
    return approvals_dir() / f"{approval_id}.json"


def list_approvals():
    d = approvals_dir()
    if not d.exists():
        return []
    out = []
    for f in d.glob("*.json"):
        try:
            out.append(json.loads(f.read_text()))
        except Exception:
            continue
    out.sort(key=lambda a: a.get("createdAt", 0), reverse=True)
    return out


def decide(approval_id: str, decision: str, by: str = "cli"):
    f = _file(approval_id)
    if not f.exists():
        return {"ok": False, "error": f"unknown approval id: {approval_id}"}
    try:
        rec = json.loads(f.read_text())
    except Exception as e:
        return {"ok": False, "error": str(e)}
    if rec.get("status") != "pending":
        return {"ok": False, "error": f"already {rec.get('status')}"}
    rec["status"] = "approved" if decision == "approve" else "denied"
    rec["decidedAt"] = int(time.time() * 1000)
    rec["decidedBy"] = by
    f.write_text(json.dumps(rec, indent=2))
    return {"ok": True, "approval": rec}


def _redact(args: dict) -> dict:
    out = {}
    for k, v in (args or {}).items():
        if _SECRET_RE.search(k):
            out[k] = "***"
        elif k == "command" and isinstance(v, str) and len(v) > 4000:
            out[k] = v[:4000] + "…"
        else:
            out[k] = v
    return out


def request_approval(tool: str, args: dict, cfg: dict) -> dict:
    """Create a pending request and block until a local human decides."""
    ensure_dirs()
    approval_id = str(uuid.uuid4())
    now = int(time.time() * 1000)
    rec = {
        "id": approval_id,
        "tool": tool,
        "args": _redact(args),
        "status": "pending",
        "createdAt": now,
        "expiresAt": now + int(cfg.get("approvalTtlSec", 900)) * 1000,
        "decidedAt": None,
        "decidedBy": None,
    }
    _file(approval_id).write_text(json.dumps(rec, indent=2))

    # tell the user about it right away, so a pending request is not a dead end
    if (cfg.get("telegram") or {}).get("enabled") and (cfg.get("telegram") or {}).get("botToken"):
        try:
            send_telegram(
                cfg,
                title="Approval needed",
                text=(
                    "Tool: {}\n"
                    "id: {}\n"
                    "Reply /approve {} or /deny {} in Telegram, or run: arena-bridge approve {}"
                ).format(tool, approval_id, approval_id, approval_id, approval_id),
            )
        except Exception:
            pass

    wait = min(int(cfg.get("approvalWaitSec", 90)), int(cfg.get("approvalTtlSec", 900)))
    deadline = time.time() + wait
    while time.time() < deadline:
        time.sleep(0.4)
        try:
            cur = json.loads(_file(approval_id).read_text())
        except Exception:
            continue
        if cur.get("status") == "approved":
            return {"approved": True, "rec": cur}
        if cur.get("status") == "denied":
            return {"approved": False, "rec": cur}
        if cur.get("expiresAt") and int(time.time() * 1000) > cur["expiresAt"]:
            return {"approved": False, "rec": {**cur, "status": "expired"}}
    return {"approved": False, "rec": {**rec, "status": "timeout"}}
