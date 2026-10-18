"""Isolated service lifecycle tests: python3 test/test_service.py."""
import os
import pathlib
import plistlib
import subprocess
import sys
import tempfile
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
with tempfile.TemporaryDirectory(prefix="arena-service-py-") as tmp:
    root = pathlib.Path(tmp)
    os.environ["ARENA_BRIDGE_HOME"] = str(root / "config")
    os.environ["ARENA_BRIDGE_APP"] = str(root / "Arena Bridge.app")
    from arena_bridge import service as m
    plist = root / "agent.plist"
    calls = []
    def run(args, **kw):
        calls.append(args)
        return subprocess.CompletedProcess(args, 0, "", "")
    with patch.object(m, "plist_path", return_value=plist), patch.object(m.subprocess, "run", side_effect=run):
        options = dict(bin="ngrok", domain="x.ngrok-free.dev", port=9999)
        assert m.service_install(**options)["scheduled"]
        assert plistlib.loads(plist.read_bytes())["ProgramArguments"][0] == str(m.runner_path())
        helper = pathlib.Path(os.environ["ARENA_BRIDGE_APP"]) / "Contents/Helpers/arena-bridge-agent"
        helper.parent.mkdir(parents=True)
        (helper.parent.parent / "Info.plist").write_text("<plist/>")
        helper.write_text("#!/bin/sh\n")
        assert m.agent_path() is None
        helper.chmod(0o755)
        assert m.service_install(**options)["scheduled"]
        data = plistlib.loads(plist.read_bytes())
        assert data["ProgramArguments"] == [str(helper), sys.executable, "-m", "arena_bridge", "tunnel", "--bin", "ngrok", "--domain", options["domain"], "--port", "9999"]
        assert data["RunAtLoad"] and data["KeepAlive"]
        assert all(a[1] == "submit" for a in calls)
        script = pathlib.Path(calls[-1][calls[-1].index("/bin/sh") + 1])
        assert script.read_text() == m.RELOAD_SCRIPT
        m.service_uninstall()
        assert not plist.exists()
    with patch.object(m, "plist_path", return_value=plist), patch.object(m.subprocess, "run", side_effect=OSError("unavailable")):
        assert m.service_install()["ok"] is False
print("PASS: service install/reinstall, actual plist, helper/fallback, queued reload, errors, uninstall")
