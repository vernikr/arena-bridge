import json
import time
from datetime import datetime, timezone

from .config import audit_path, config_dir


def audit(entry: dict) -> None:
    try:
        config_dir().mkdir(parents=True, exist_ok=True)
        rec = {"ts": datetime.now(timezone.utc).isoformat(), **entry}
        with open(audit_path(), "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, default=str) + "\n")
    except Exception:
        pass


def tail_audit(n: int = 50):
    p = audit_path()
    if not p.exists():
        return []
    lines = [l for l in p.read_text(errors="replace").splitlines() if l.strip()]
    out = []
    for line in lines[-n:]:
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            out.append({"raw": line})
    return out
