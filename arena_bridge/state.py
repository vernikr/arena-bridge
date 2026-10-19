import json, os
from pathlib import Path
from .config import config_dir, config_path

def state_path() -> Path:
    return config_dir() / "state.json"

def load_state() -> dict:
    p = state_path()
    if p.exists():
        try:
            return json.loads(p.read_text())
        except: return {}
    return {}

def save_state(patch: dict) -> dict:
    p = state_path()
    cur = {}
    if p.exists():
        try: cur = json.loads(p.read_text())
        except: cur = {}
    # migrate publicUrl from config.json if needed
    if not cur.get("publicUrl") and config_path().exists():
        try:
            cfg = json.loads(config_path().read_text())
            if cfg.get("publicUrl"):
                cur["publicUrl"] = cfg["publicUrl"]
                try:
                    out = {k:v for k,v in cfg.items() if k != "publicUrl"}
                    tmp = config_path().with_suffix(".tmp")
                    tmp.write_text(json.dumps(out, indent=2) + "\n")
                    tmp.replace(config_path())
                except: pass
        except: pass
    cur.update(patch or {})
    p.parent.mkdir(parents=True, exist_ok=True)
    try: p.parent.chmod(0o700)
    except: pass
    import tempfile
    fd, tmp = tempfile.mkstemp(dir=str(p.parent))
    try:
        os.write(fd, json.dumps(cur, indent=2).encode() + b"\n")
        os.close(fd)
        fd = None
        os.replace(tmp, str(p))
        try: os.chmod(str(p), 0o600)
        except: pass
    finally:
        if fd is not None:
            try: os.close(fd)
            except: pass
        try: os.unlink(tmp)
        except: pass
    return cur

def clear_state_key(key: str):
    p = state_path()
    if not p.exists(): return
    try:
        cur = json.loads(p.read_text())
        if key in cur:
            del cur[key]
            tmp = p.with_suffix(".tmp")
            tmp.write_text(json.dumps(cur, indent=2) + "\n")
            tmp.replace(p)
    except: pass
