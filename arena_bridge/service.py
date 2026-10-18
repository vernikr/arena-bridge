"""macOS launchd service that keeps the bridge running with the system."""

from __future__ import annotations

import os
import plistlib
import subprocess
import sys
from pathlib import Path

from .app import AGENT_NAME, APP_NAME, SERVICE_LABEL as LABEL
from .config import config_dir, ensure_dirs


def plist_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def runner_path() -> Path:
    """The launchd agent starts this script, so the system settings show the app name."""
    return config_dir() / APP_NAME


def app_bundle_path() -> Path | None:
    """The app bundle that holds the helper. It gives the screen and the accessibility
    permissions to the app and not to the python binary."""
    explicit = os.environ.get("ARENA_BRIDGE_APP")
    if explicit:
        candidates = [Path(explicit)]
    else:
        candidates = [
            Path("/Applications") / f"{APP_NAME}.app",
            Path.home() / "Applications" / f"{APP_NAME}.app",
        ]
    for candidate in candidates:
        if (candidate / "Contents" / "Info.plist").exists():
            return candidate
    return None


def agent_path() -> Path | None:
    """The helper inside the bundle starts the bridge. macOS gives the permissions to the
    app that starts the request, so the system settings show the name of the app."""
    bundle = app_bundle_path()
    if not bundle:
        return None
    helper = bundle / "Contents" / "Helpers" / AGENT_NAME
    return helper if helper.exists() else None


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


def program_arguments(bin=None, domain=None, authtoken=None, port=None) -> list[str]:
    """The command the service starts. The helper inside the app bundle gives the screen and
    the accessibility permissions to the app, so the system settings show its name. Without the
    app the service starts the wrapper script."""
    extra = []
    for flag, value in (("--bin", bin), ("--domain", domain), ("--authtoken", authtoken), ("--port", port)):
        if value:
            extra += [flag, str(value)]
    helper = agent_path()
    if helper:
        return [str(helper), *cli_entry(), "tunnel", *extra]
    return [str(runner_path()), "tunnel", *extra]


def service_payload(bin=None, domain=None, authtoken=None, port=None) -> dict:
    """The content of the launchd agent."""
    logs = log_dir()
    return {
        "Label": LABEL,
        "ProgramArguments": program_arguments(bin, domain, authtoken, port),
        "RunAtLoad": True,
        "KeepAlive": True,
        "StandardOutPath": str(logs / "bridge.log"),
        "StandardErrorPath": str(logs / "bridge.err.log"),
        "EnvironmentVariables": {"PATH": service_path()},
    }


def service_install(bin=None, domain=None, authtoken=None, port=None) -> dict:
    ensure_dirs()
    logs = log_dir()
    logs.mkdir(parents=True, exist_ok=True)
    plist = plist_path()
    plist.parent.mkdir(parents=True, exist_ok=True)
    runner = runner_path()
    runner.write_text(runner_script(), encoding="utf-8")
    runner.chmod(0o755)
    payload = service_payload(bin, domain, authtoken, port)
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
