"""Self-update: compare the installed version with the npm registry."""

from __future__ import annotations

import json
import subprocess
import time
import urllib.request

PKG = "arena-bridge"


def package_info() -> dict:
    try:
        from importlib import metadata

        return {"name": PKG, "version": metadata.version(PKG)}
    except Exception:
        try:
            from . import __version__

            return {"name": PKG, "version": __version__}
        except Exception:
            return {"name": PKG, "version": "0.0.0"}


def compare_versions(a: str, b: str) -> int:
    pa = [int(x) for x in str(a).split(".") if x.isdigit()]
    pb = [int(x) for x in str(b).split(".") if x.isdigit()]
    for i in range(3):
        va, vb = (pa[i] if i < len(pa) else 0), (pb[i] if i < len(pb) else 0)
        if va != vb:
            return 1 if va > vb else -1
    return 0


def latest_version(timeout: float = 8.0) -> str | None:
    try:
        with urllib.request.urlopen(f"https://registry.npmjs.org/{PKG}/latest", timeout=timeout) as res:
            data = json.loads(res.read().decode("utf-8"))
            return data.get("version")
    except Exception:
        return None


def self_update(dry_run: bool = False) -> dict:
    info = package_info()
    latest = latest_version()
    if not latest:
        return {"ok": False, "error": "the npm registry is not reachable from this machine"}
    if compare_versions(latest, info["version"]) <= 0:
        return {"ok": True, "up_to_date": True, "installed": info["version"], "latest": latest}
    if dry_run:
        return {"ok": True, "up_to_date": False, "installed": info["version"], "latest": latest, "command": f"pip install -U {PKG}"}
    try:
        proc = subprocess.run(
            ["pip", "install", "-U", PKG],
            capture_output=True,
            text=True,
            timeout=600,
        )
        if proc.returncode != 0 and "notarget" in (proc.stderr or "").lower():
            time.sleep(15)
            proc = subprocess.run(
                ["pip", "install", "-U", f"{PKG}=={latest}"],
                capture_output=True,
                text=True,
                timeout=600,
            )
    except Exception as exc:  # pragma: no cover - defensive
        return {"ok": False, "error": "pip install failed", "detail": str(exc), "installed": info["version"], "latest": latest}
    if proc.returncode != 0:
        return {
            "ok": False,
            "error": "pip install failed",
            "detail": (proc.stderr or proc.stdout or "")[:600],
            "installed": info["version"],
            "latest": latest,
        }
    return {
        "ok": True,
        "updated": True,
        "installed": info["version"],
        "latest": latest,
        "output": (proc.stdout or proc.stderr or "")[:1200],
    }
