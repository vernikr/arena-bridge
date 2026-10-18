"""macOS launchd service that keeps the bridge running with the system."""

from __future__ import annotations

import os
import plistlib
import subprocess
import sys
from pathlib import Path

from .app import APP_NAME, SERVICE_LABEL as LABEL
from .config import config_dir, ensure_dirs


def plist_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def runner_path() -> Path:
    """The launchd agent starts this script, so the system settings show the app name."""
    return config_dir() / APP_NAME


def stable_node() -> str:
    """The version manager keeps node in a folder that every new shell creates and that is
    deleted afterwards. macOS binds a permission to the exact file, so the service uses the
    permanent installation instead."""
    exec_path = sys.executable
    if "fnm_multishells" not in exec_path:
        return exec_path
    versions = Path.home() / ".local" / "share" / "fnm" / "node-versions"
    try:
        dirs = sorted(
            (p for p in versions.iterdir() if (p / "installation" / "bin" / "node").exists()),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
    except OSError:
        return exec_path
    return str(dirs[0] / "installation" / "bin" / "node") if dirs else exec_path


def service_path() -> str:
    """The PATH of the service: permanent folders only."""
    parts = [p for p in (os.environ.get("PATH") or "/usr/local/bin:/usr/bin:/bin").split(":")
             if p and "fnm_multishells" not in p]
    home = str(Path.home() / ".local" / "bin")
    node_bin = str(Path(stable_node()).parent)
    return ":".join([home, node_bin] + [p for p in parts if p not in (home, node_bin)])


def log_dir() -> Path:
    return config_dir() / "logs"


def cli_entry() -> list[str]:
    return [sys.executable, "-m", "arena_bridge"]


def runner_script() -> str:
    command = " ".join(f'"{part}"' for part in cli_entry())
    return f"#!/bin/sh\n# {APP_NAME}: the background service of the bridge.\nexec {command} \"$@\"\n"


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


def service_install(bin=None, domain=None, authtoken=None, port=None) -> dict:
    ensure_dirs()
    logs = log_dir()
    logs.mkdir(parents=True, exist_ok=True)
    plist = plist_path()
    plist.parent.mkdir(parents=True, exist_ok=True)
    arguments = ["tunnel"]
    for flag, value in (("--bin", bin), ("--domain", domain), ("--authtoken", authtoken), ("--port", port)):
        if value:
            arguments += [flag, str(value)]
    runner = runner_path()
    runner.write_text(runner_script(), encoding="utf-8")
    runner.chmod(0o755)
    payload = {
        "Label": LABEL,
        "ProgramArguments": arguments,
        "RunAtLoad": True,
        "KeepAlive": True,
        "StandardOutPath": str(logs / "bridge.log"),
        "StandardErrorPath": str(logs / "bridge.err.log"),
        "EnvironmentVariables": {"PATH": service_path()},
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
