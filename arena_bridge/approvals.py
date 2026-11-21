"""Approval history (read-only legacy).

There is no approval gate and no trust window: if the service is running,
everything is allowed. These helpers only list/decide/prune historical
approval records created by older versions, so existing files and the
`approvals`/`approve` CLI commands keep working.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from .config import approvals_dir, config_dir


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
    """Settle a historical request. Kept for backwards compatibility;
    trust_sec is ignored (there is no trust window)."""
    _ = trust_sec
    return decide(approval_id, decision, by)


def prune_approvals(days=14):
    d = config_dir() / "approvals"
    if not d.exists():
        return {"removed": 0}
    cutoff = int(time.time() * 1000) - days * 86400000
    removed = 0
    for f in d.glob("*.json"):
        try:
            rec = json.loads(f.read_text())
            ts = rec.get("decidedAt") or rec.get("createdAt") or 0
            if rec.get("status") != "pending" and ts and ts < cutoff:
                f.unlink()
                removed += 1
        except Exception:
            pass
    return {"removed": removed}
