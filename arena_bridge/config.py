import json
import os
import secrets
from pathlib import Path

VERSION = "0.7.19"


def config_dir() -> Path:
    return Path(os.environ.get("ARENA_BRIDGE_HOME", str(Path.home() / ".arena-bridge")))


def config_path() -> Path:
    return config_dir() / "config.json"


def audit_path() -> Path:
    return config_dir() / "audit.log"


def approvals_dir() -> Path:
    return config_dir() / "approvals"


PROTECTED_DEFAULT = [
    "~/.arena-bridge",
    "~/.ssh",
    "~/.gnupg",
    "~/.aws",
    "~/.azure",
    "~/.kube",
    "~/.docker",
    "~/.config/gh",
    "~/.config/gcloud",
    "~/.npmrc",
    "~/.pypirc",
    "~/.netrc",
    "~/.git-credentials",
    "~/Library/Keychains",
    "~/Library/Application Support/Google/Chrome",
    "~/Library/Application Support/Firefox",
    "~/.mozilla",
]


def defaults() -> dict:
    return {
        "mode": "direct",
        "host": "127.0.0.1",
        "port": 8787,
        "publicUrl": None,
        "token": None,
        "deviceToken": None,
        "localToken": None,
        "hub": None,
        "device": os.uname().nodename if hasattr(os, "uname") else "device",
        "roots": [str(Path.home())],
        "protected": list(PROTECTED_DEFAULT),
        "allowShell": True,
        "requireApproval": True,
        "approvalWaitSec": 45,
        "approvalTtlSec": 900,
        "peekabooPath": None,
        "maxOutputBytes": 8 * 1024 * 1024,
        "maxUploadBytes": 16 * 1024 * 1024,
        "commandTimeoutSec": 120,
        "audit": True,
        "telegram": {
            "enabled": False,
            "botToken": None,
            "chatIds": [],
            "poll": True,
            "apiId": None,
            "apiHash": None,
        },
    }


def expand_home(p: str) -> str:
    p = str(p)
    if p == "~":
        return str(Path.home())
    if p.startswith("~/"):
        return str(Path.home() / p[2:])
    return p


def ensure_dirs() -> None:
    config_dir().mkdir(parents=True, exist_ok=True)
    approvals_dir().mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(config_dir(), 0o700)
    except OSError:
        pass


def load_config() -> dict:
    cfg = defaults()
    p = config_path()
    if p.exists():
        cfg.update(json.loads(p.read_text()))
    cfg["roots"] = [str(Path(expand_home(r)).resolve()) for r in cfg.get("roots") or []]
    cfg["protected"] = [str(Path(expand_home(r)).resolve()) for r in cfg.get("protected") or []]
    cfg["configPath"] = str(p)
    return cfg


def save_config(cfg: dict) -> None:
    ensure_dirs()
    out = {k: v for k, v in cfg.items() if k != "configPath"}
    p = config_path()
    p.write_text(json.dumps(out, indent=2) + "\n")
    try:
        os.chmod(p, 0o600)
    except OSError:
        pass


def random_token(n: int = 32) -> str:
    return secrets.token_urlsafe(n)
