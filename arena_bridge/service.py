"""macOS launchd service that keeps the bridge running with the system."""

from __future__ import annotations

import os
import plistlib
import subprocess
import sys
from pathlib import Path

from .config import config_dir, ensure_dirs

LABEL = "ai.arena.bridge"


def plist_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def log_dir() -> Path:
    return config_dir() / "logs"


def cli_entry() -> list[str]:
    return [sys.executable, "-m", "arena_bridge"]


def _launchctl(args: list[str]) -> str:
    try:
        proc = subprocess.run(["launchctl", *args], capture_output=True, text=True, timeout=20)
        return (proc.stdout or "") + (proc.stderr or "")
    except Exception as exc:  # pragma: no cover - defensive
        return str(exc)


def service_status() -> dict:
    plist = plist_path()
    out = _launchctl(["print", f"gui/{os.getuid()}/{LABEL}"])
    return {
        "installed": plist.exists(),
        "running": "state = running" in out,
        "plist": str(plist),
        "detail": out.strip()[:600],
    }


def service_install() -> dict:
    ensure_dirs()
    logs = log_dir()
    logs.mkdir(parents=True, exist_ok=True)
    plist = plist_path()
    plist.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "Label": LABEL,
        "ProgramArguments": [*cli_entry(), "tunnel"],
        "RunAtLoad": True,
        "KeepAlive": True,
        "StandardOutPath": str(logs / "bridge.log"),
        "StandardErrorPath": str(logs / "bridge.err.log"),
        "EnvironmentVariables": {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin")},
    }
    with open(plist, "wb") as fh:
        plistlib.dump(payload, fh)
    _launchctl(["bootout", f"gui/{os.getuid()}/{LABEL}"])
    out = _launchctl(["bootstrap", f"gui/{os.getuid()}", str(plist)])
    _launchctl(["enable", f"gui/{os.getuid()}/{LABEL}"])
    return {"ok": True, "plist": str(plist), "detail": out.strip()[:400]}


def service_uninstall() -> dict:
    _launchctl(["bootout", f"gui/{os.getuid()}/{LABEL}"])
    plist = plist_path()
    if plist.exists():
        plist.unlink()
    return {"ok": True, "removed": str(plist)}
