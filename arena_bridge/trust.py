"""Trust window: lets the agent act without asking for approval every time."""

import json
import os
import re
import time
from pathlib import Path

from .config import config_dir, ensure_dirs
from .policy import is_inside, resolve_target


def trust_path() -> Path:
    return config_dir() / "trust.json"


def parse_duration(value) -> int:
    """'30m' | '2h' | '1d' | '90' (minutes) -> milliseconds."""
    if value is None or value is True:
        return 60 * 60 * 1000
    raw = str(value).strip().lower()
    m = re.match(r"^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$", raw)
    if not m:
        raise ValueError(f"cannot parse duration: {value}")
    factor = {"s": 1000, "m": 60_000, "h": 3_600_000, "d": 86_400_000}[m.group(2) or "m"]
    return int(float(m.group(1)) * factor)


def load_trust():
    p = trust_path()
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def save_trust(state: dict) -> dict:
    ensure_dirs()
    trust_path().write_text(json.dumps(state, indent=2))
    try:
        os.chmod(trust_path(), 0o600)
    except OSError:
        pass
    return state


def clear_trust():
    p = trust_path()
    if p.exists():
        p.unlink()


def trust_state() -> dict:
    t = load_trust()
    if not t:
        return {"active": False, "until": None, "tools": [], "paths": []}
    expired = not t.get("until") or t["until"] <= int(time.time() * 1000)
    return {
        "active": (not expired) and t.get("enabled", True),
        "expired": expired,
        "until": t.get("until"),
        "tools": t.get("tools") or [],
        "paths": t.get("paths") or [],
        "createdAt": t.get("createdAt"),
    }


def trust_allows(state: dict, tool_name: str, args=None, cfg=None) -> bool:
    if not state or not state.get("active"):
        return False
    args = args or {}
    tools = state.get("tools") or []
    paths = state.get("paths") or []

    if tools:
        return tool_name in tools

    if paths:
        target = args.get("path") or args.get("file_path")
        if not target:
            return False
        try:
            base = (cfg or {}).get("base") or os.getcwd()
            abs_path = resolve_target(target, base)
            return any(is_inside(abs_path, resolve_target(p, base)) for p in paths)
        except Exception:
            return False
    return True
