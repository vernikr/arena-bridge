import json
import os
import secrets
from pathlib import Path

try:
    from importlib.metadata import version as _pkg_version
    VERSION = _pkg_version("arena-bridge")
except Exception:
    import json, pathlib
    try:
        VERSION = json.loads((pathlib.Path(__file__).parent.parent / "package.json").read_text()).get("version", "0.8.2")
    except Exception:
        VERSION = "0.8.2"


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
        "exposeDeviceInHealth": True,
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
        try:
            cfg.update(json.loads(p.read_text()))
        except: pass
    # merge state publicUrl (B7: config = intent, state = runtime)
    try:
        sp = config_dir() / "state.json"
        if sp.exists():
            state = json.loads(sp.read_text())
            if state.get("publicUrl") and not cfg.get("publicUrl"):
                # also handle case where cfg already has publicUrl but empty
                cfg["publicUrl"] = state["publicUrl"]
            # keep state for debug
            cfg["_state"] = state
    except: pass
    # migrate publicUrl from config to state if needed
    try:
        if p.exists():
            raw = json.loads(p.read_text())
            if raw.get("publicUrl"):
                sp = config_dir() / "state.json"
                cur = {}
                if sp.exists():
                    try: cur = json.loads(sp.read_text())
                    except: cur = {}
                if not cur.get("publicUrl"):
                    cur["publicUrl"] = raw["publicUrl"]
                    sp.parent.mkdir(parents=True, exist_ok=True)
                    sp.write_text(json.dumps(cur, indent=2) + "\n")
                # remove from config
                del raw["publicUrl"]
                tmp = p.with_suffix(".tmp")
                tmp.write_text(json.dumps(raw, indent=2) + "\n")
                tmp.replace(p)
                cfg.pop("publicUrl", None)
                if raw.get("publicUrl"):
                    cfg["publicUrl"] = raw["publicUrl"]
    except: pass
    cfg["roots"] = [str(Path(expand_home(r)).resolve()) for r in cfg.get("roots") or []]
    cfg["protected"] = [str(Path(expand_home(r)).resolve()) for r in cfg.get("protected") or []]
    cfg["configPath"] = str(p)
    return cfg


def save_config(cfg: dict) -> None:
    ensure_dirs()
    p = config_path()
    # B7: publicUrl is runtime — store in state.json, not config.json
    if "publicUrl" in cfg:
        try:
            from .state import save_state, clear_state_key
            if cfg["publicUrl"]:
                save_state({"publicUrl": cfg["publicUrl"]})
            else:
                clear_state_key("publicUrl")
        except: pass
    existing = {}
    if p.exists():
        try:
            existing = json.loads(p.read_text())
        except Exception:
            existing = {}
    out = dict(existing)
    defs = defaults()
    for k, v in cfg.items():
        if k in ("configPath", "_state", "publicUrl"):
            continue
        already = k in existing
        if already or json.dumps(v, sort_keys=True) != json.dumps(defs.get(k), sort_keys=True) or k in ("token","deviceToken","localToken","hub","device","port","host","mode"):
            out[k] = v
    import tempfile, os as _os
    fd, tmp = tempfile.mkstemp(dir=str(p.parent))
    try:
        _os.write(fd, json.dumps(out, indent=2).encode() + b"\n")
        _os.close(fd)
        fd = None
        _os.replace(tmp, str(p))
        try: _os.chmod(str(p), 0o600)
        except: pass
    finally:
        if fd is not None:
            try: _os.close(fd)
            except: pass
        try: _os.unlink(tmp)
        except: pass


def random_token(n: int = 32) -> str:
    return secrets.token_urlsafe(n)
