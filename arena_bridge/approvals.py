from __future__ import annotations

import json
import re
import time
import uuid
from pathlib import Path

from .config import approvals_dir, ensure_dirs
from .telegram import approval_keyboard, send_telegram
from .trust import save_trust

_SECRET_RE = re.compile(r"token|secret|password|authorization", re.IGNORECASE)


def _file(approval_id: str) -> Path:
    return approvals_dir() / f"{approval_id}.json"


def _expire_if_needed(path: Path, rec: dict, now: int | None = None) -> dict:
    now = now or int(time.time() * 1000)
    if rec.get("status") == "pending" and rec.get("expiresAt") and now >= rec["expiresAt"]:
        rec["status"] = "expired"
        rec["decidedAt"] = now
        rec["decidedBy"] = "system"
        tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(rec, indent=2))
    try: tmp.chmod(0o600)
    except: pass
    tmp.replace(path)
    return rec


def list_approvals():
    d = approvals_dir()
    if not d.exists():
        return []
    out = []
    for f in d.glob("*.json"):
        try:
            out.append(_expire_if_needed(f, json.loads(f.read_text())))
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
    rec = _expire_if_needed(f, rec)
    if rec.get("status") != "pending":
        return {"ok": False, "error": f"already {rec.get('status')}"}
    rec["status"] = "approved" if decision == "approve" else "denied"
    rec["decidedAt"] = int(time.time() * 1000)
    rec["decidedBy"] = by
    f.write_text(json.dumps(rec, indent=2))
    return {"ok": True, "approval": rec}


def settle(approval_id: str, decision: str, by: str = "cli", trust_sec: int = 0) -> dict:
    """Settle a request and, when asked, open a blanket trust window (all tools, any agent)."""
    res = decide(approval_id, decision, by)
    if res.get("ok") and trust_sec > 0:
        save_trust(
            {
                "enabled": True,
                "until": int(time.time() * 1000) + trust_sec * 1000,
                "tools": [],  # blanket: all tools, any agent
                "paths": [],
                "createdAt": int(time.time() * 1000),
            }
        )
    return res


def _redact(args: dict) -> dict:
    def _scrub(v):
        if isinstance(v, dict):
            out2 = {}
            for kk, vv in v.items():
                if _SECRET_RE.search(kk):
                    out2[kk] = "***"
                else:
                    out2[kk] = _scrub(vv)
            return out2
        if isinstance(v, list):
            return [_scrub(x) for x in v]
        return v
    out = {}
    for k, v in (args or {}).items():
        if _SECRET_RE.search(k):
            out[k] = "***"
        elif k == "command" and isinstance(v, str) and len(v) > 4000:
            out[k] = v[:4000] + "…"
        else:
            out[k] = _scrub(v) if isinstance(v, (dict, list)) else v
    return out


def prune_approvals(days=14):
    from pathlib import Path
    import time, json as _j
    d = config_dir() / "approvals"
    if not d.exists(): return {"removed": 0}
    cutoff = int(time.time()*1000) - days*86400000
    removed=0
    for f in d.glob("*.json"):
        try:
            rec=_j.loads(f.read_text())
            ts=rec.get("decidedAt") or rec.get("createdAt") or 0
            if rec.get("status")!="pending" and ts and ts < cutoff:
                f.unlink()
                removed+=1
        except: pass
    return {"removed": removed}

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
    _tmp = _file(approval_id).with_suffix(".tmp")
    _tmp.write_text(json.dumps(rec, indent=2))
    try: _tmp.chmod(0o600)
    except: pass
    _tmp.replace(_file(approval_id))

    # tell the user about it right away, so a pending request is not a dead end
    if (cfg.get("telegram") or {}).get("enabled") and (cfg.get("telegram") or {}).get("botToken"):
        try:
            send_telegram(
                cfg,
                title="Approval needed",
                text=(
                    "Tool: {}\n"
                    "id: {}\n"
                    "Use the buttons below, reply /approve {} or /deny {}, or run: arena-bridge approve {}"
                ).format(tool, approval_id, approval_id, approval_id, approval_id),
                buttons=approval_keyboard(approval_id),
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
        if cur.get("status") != "pending":
            return {"approved": False, "rec": cur}
        if cur.get("expiresAt") and int(time.time() * 1000) >= cur["expiresAt"]:
            return {"approved": False, "rec": _expire_if_needed(_file(approval_id), cur)}
    timed_out = _expire_if_needed(_file(approval_id), json.loads(_file(approval_id).read_text()))
    if timed_out.get("status") == "pending":
        timed_out["status"] = "timeout"
        timed_out["decidedAt"] = int(time.time() * 1000)
        timed_out["decidedBy"] = "system"
        _file(approval_id).write_text(json.dumps(timed_out, indent=2))
    return {"approved": timed_out.get("status") == "approved", "rec": timed_out}
