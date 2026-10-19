import os
from pathlib import Path

from .config import expand_home


def resolve_target(p, base=None) -> Path:
    """Resolve a user supplied path, following symlinks on the existing prefix (including dangling links)."""
    raw = expand_home(str(p).strip())
    if not raw:
        raise ValueError("path is required")
    base = base or os.getcwd()
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = Path(base) / candidate
    candidate = Path(os.path.normpath(str(candidate)))

    # Use lstat to detect dangling symlinks (B1 fix): exists() follows symlink and returns False for dangling,
    # but lstat returns True. We walk components and resolve symlinks via readlink.
    cur = candidate
    seen = set()
    for _ in range(20):
        # Find deepest existing via lstat (includes dangling symlinks)
        probe = cur
        tail = []
        while True:
            try:
                st = probe.lstat()
                # if probe is symlink, resolve it
                if probe.is_symlink():
                    try:
                        link = probe.readlink()
                    except OSError:
                        break
                    # resolve link relative to its parent
                    target = (probe.parent / link).resolve(strict=False) if not Path(link).is_absolute() else Path(link).resolve(strict=False)
                    rest = cur.relative_to(probe) if cur != probe else Path(".")
                    if str(target) in seen:
                        break
                    seen.add(str(target))
                    cur = target / rest if str(rest) != "." else target
                    probe = cur
                    tail = []
                    continue
                break
            except FileNotFoundError:
                parent = probe.parent
                if parent == probe:
                    break
                tail.insert(0, probe.name)
                probe = parent
            except OSError:
                break
        try:
            real = probe.resolve(strict=False)
        except OSError:
            real = probe
        cur = real.joinpath(*tail) if tail else real
        # Check if cur itself is symlink not yet resolved
        try:
            if cur.lstat().is_symlink():
                continue
        except FileNotFoundError:
            pass
        # Check tail for symlink that was missed
        has_symlink = False
        check = real
        for part in tail:
            check = check / part
            try:
                if check.lstat().is_symlink():
                    has_symlink = True
                    break
            except FileNotFoundError:
                pass
        if not has_symlink:
            break
    return Path(os.path.normpath(str(cur)))


def _resolve_configured(p, base=None) -> Path:
    """Resolve a configured path the same way as a target, so symlinks never break the comparison."""
    try:
        return resolve_target(p, base)
    except ValueError:
        return Path(os.path.normpath(str(p)))


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
        if is_inside(abs_path, _resolve_configured(prot, base)):
            return False, abs_path, "PROTECTED", f"path is inside a protected location ({prot})"

    roots = cfg.get("roots") or []
    if not any(is_inside(abs_path, _resolve_configured(r, base)) for r in roots):
        return False, abs_path, "PROTECTED", f"path is outside the authorized roots ({', '.join(roots)})"

    return True, abs_path, None, None
