"""arena-bridge — controlled remote access to your own machine for cloud AI agents."""

try:
    from importlib.metadata import version as _pkg_version
    __version__ = _pkg_version("arena-bridge")
except Exception:
    try:
        import json, pathlib
        _pkg = pathlib.Path(__file__).parent.parent / "package.json"
        __version__ = json.loads(_pkg.read_text()).get("version", "0.8.1")
    except Exception:
        __version__ = "0.8.1"
