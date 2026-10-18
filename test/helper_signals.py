"""macOS helper regression: python3 test/helper_signals.py."""
import pathlib
import signal
import subprocess
import sys
import tempfile
import time

if sys.platform != "darwin":
    print("SKIP: macOS required")
    sys.exit(0)

root = pathlib.Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix="arena-helper-test-") as tmp:
    binary = str(pathlib.Path(tmp) / "agent")
    subprocess.run([
        "swiftc", "-O", "-swift-version", "5",
        str(root / "macos/ArenaBridge/Helper/main.swift"), "-o", binary,
    ], check=True)
    for sig in (signal.SIGTERM, signal.SIGINT):
        child = subprocess.Popen([binary, "/bin/sleep", "60"])
        try:
            time.sleep(0.5)
            child.send_signal(sig)
            assert child.wait(timeout=5) == 128 + sig, sig
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
    result = subprocess.run(
        [binary, "/bin/sh", "-c", "echo stdout; echo stderr >&2; exit 7"],
        capture_output=True, text=True, check=False,
    )
    assert (result.returncode, result.stdout.strip(), result.stderr.strip()) == (7, "stdout", "stderr")
print("PASS: SIGTERM, SIGINT, exit status, stdout, stderr")
