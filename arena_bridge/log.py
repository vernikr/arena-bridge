import json, os, logging
from datetime import datetime, timezone
from pathlib import Path
from .config import config_dir

LEVELS = {"debug":10, "info":20, "warn":30, "error":40}
def _level_val(l): return LEVELS.get(str(l).lower(), 20)
def _current_level(): return _level_val(os.environ.get("LOG_LEVEL") or os.environ.get("ARENA_LOG_LEVEL") or "info")

def _log_path(): return config_dir() / "logs" / "bridge.log"

def log(level, msg, fields=None):
    if _level_val(level) < _current_level():
        return
    try:
        p = _log_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        try: os.chmod(p.parent, 0o700)
        except: pass
        rec = {"ts": datetime.now(timezone.utc).isoformat(), "level": str(level).lower(), "msg": str(msg), "pid": os.getpid()}
        if fields: rec.update(fields)
        with open(p, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, default=str) + "\n")
        try: os.chmod(p, 0o600)
        except: pass
        # rotate if >5MB
        try:
            if p.stat().st_size > 5*1024*1024:
                lines = p.read_text(errors="replace").strip().splitlines()
                keep = lines[len(lines)//2:]
                tmp = p.with_suffix(".tmp")
                tmp.write_text("\n".join(keep) + "\n")
                tmp.replace(p)
        except: pass
    except: pass

def log_info(msg, fields=None): log("info", msg, fields)
def log_warn(msg, fields=None): log("warn", msg, fields)
def log_error(msg, fields=None): log("error", msg, fields)
def log_debug(msg, fields=None): log("debug", msg, fields)
