import os
from pathlib import Path

from .config import expand_home


def resolve_target(p, base=None) -> Path:
    """Resolve a user supplied path, following symlinks on the existing prefix."""
    raw = expand_home(str(p).strip())
    if not raw:
        raise ValueError("path is required")
    base = base or os.getcwd()
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = Path(base) / candidate
    candidate = Path(os.path.normpath(str(candidate)))

    # find the deepest existing ancestor and realpath it
    probe = candidate
    tail = []
    while not probe.exists():
        parent = probe.parent
        if parent == probe:
            break
        tail.insert(0, probe.name)
        probe = parent
    try:
        real = probe.resolve(strict=False)
    except OSError:
        real = probe
    return Path(os.path.normpath(str(real.joinpath(*tail))))


def is_inside(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def check_path(p, cfg, base=None, write=False):
    """Returns (ok, abs_path, error, reason)."""
    try:
        abs_path = resolve_target(p, base)
    except ValueError as e:
        return False, None, "INVALID_PATH", str(e)

    for prot in cfg.get("protected") or []:
        if is_inside(abs_path, Path(prot)):
            return False, abs_path, "PROTECTED", f"path is inside a protected location ({prot})"

    roots = cfg.get("roots") or []
    if not any(is_inside(abs_path, Path(r)) for r in roots):
        return False, abs_path, "PROTECTED", f"path is outside the authorized roots ({', '.join(roots)})"

    return True, abs_path, None, None
