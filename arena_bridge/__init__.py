"""arena-bridge — controlled remote access to your own machine for cloud AI agents."""

import warnings

try:
    from importlib.metadata import version as _pkg_version
    __version__ = _pkg_version("arena-bridge")
except Exception:
    try:
        import json, pathlib
        _pkg = pathlib.Path(__file__).parent.parent / "package.json"
        __version__ = json.loads(_pkg.read_text()).get("version", "0.8.4")
    except Exception:
        __version__ = "0.8.9"

# 0.8.0: Python bridge is frozen — only security fixes. Use npm/brew for new features.
# This will become a thin shim in 0.9 or be removed per owner decision (pip-only not a priority).
try:
    warnings.warn(
        "arena-bridge Python bridge is deprecated — use npm/brew (Node) for new features. "
        "Python will receive only security fixes in 0.8.x and become a shim in 0.9. See AGENTS.md.",
        DeprecationWarning,
        stacklevel=2,
    )
except Exception:
    pass
