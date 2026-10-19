import json
import re
import time
from datetime import datetime, timezone

from pathlib import Path

from .config import audit_path, config_dir


SECRETS = [
    re.compile(r"(?<!\d)\d{6,12}:[A-Za-z0-9_-]{25,}"),  # telegram bot tokens
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),  # github tokens
    re.compile(r"\bnpm_[A-Za-z0-9]{20,}\b"),  # npm tokens
    re.compile(r"\bpypi-[A-Za-z0-9_-]{20,}\b"),  # pypi tokens
    re.compile(r"\bsk-[A-Za-z0-9]{20,}\b"),  # api keys
]


def scrub(value):
    """Mask anything that looks like a credential, so the log never becomes a secret store."""
    if isinstance(value, str):
        out = value
        for pattern in SECRETS:
            out = pattern.sub("***", out)
        return out
    if isinstance(value, list):
        return [scrub(v) for v in value]
    if isinstance(value, dict):
        return {k: scrub(v) for k, v in value.items()}
    return value


def audit(entry: dict) -> None:
    try:
        config_dir().mkdir(parents=True, exist_ok=True)
        rec = {"ts": datetime.now(timezone.utc).isoformat(), **scrub(entry)}
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


# --------------------------------------------------------------------------- #
# artifacts: screenshots, accessibility trees and other evidence
# --------------------------------------------------------------------------- #


def audit_dir() -> Path:
    return config_dir() / "audit"


def save_artifact(entry_id: str, kind: str, name: str, data, meta=None):
    try:
        directory = audit_dir() / str(entry_id)
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / Path(str(name)).name
        if isinstance(data, str):
            data = data.encode("utf-8")
        target.write_bytes(data)
        return {
            "kind": kind,
            "name": target.name,
            "path": str(target),
            "bytes": len(data),
            **(meta or {}),
        }
    except Exception:
        return None


def read_artifact(entry_id: str, name: str):
    try:
        base = audit_dir().resolve()
        # treat entry_id and name as single components
        target = (base / Path(str(entry_id)).name / Path(str(name)).name).resolve()
        if not target.is_relative_to(base) or not target.is_file():
            return None
        return {"file": str(target), "data": target.read_bytes()}
    except Exception:
        return None


def list_artifacts():
    directory = audit_dir()
    if not directory.exists():
        return []
    out = []
    for entry in sorted(directory.iterdir()):
        if not entry.is_dir():
            continue
        files = [{"name": f.name, "bytes": f.stat().st_size} for f in sorted(entry.iterdir()) if f.is_file()]
        if files:
            out.append({"entry": entry.name, "files": files})
    return out


def prune_artifacts(days: int = 14) -> dict:
    directory = audit_dir()
    if not directory.exists():
        return {"removed": 0, "freed_bytes": 0}
    import shutil

    cutoff = time.time() - days * 86400
    removed = 0
    freed = 0
    for entry in list(directory.iterdir()):
        try:
            if entry.stat().st_mtime < cutoff:
                freed += sum(f.stat().st_size for f in entry.rglob("*") if f.is_file())
                shutil.rmtree(entry, ignore_errors=True)
                removed += 1
        except Exception:
            pass
    return {"removed": removed, "freed_bytes": freed}
