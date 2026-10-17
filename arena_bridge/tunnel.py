"""cloudflared quick-tunnel helper (QUIC is blocked on many networks -> http2 by default)."""

import re
import socket
import subprocess
import threading
import time

URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com", re.IGNORECASE)
NGROK_URL_RE = re.compile(r"https://[a-z0-9-]+\.ngrok(?:-free)?\.(?:app|io|dev)", re.IGNORECASE)


def is_port_open(port, host="127.0.0.1", timeout=0.7) -> bool:
    with socket.socket() as s:
        s.settimeout(timeout)
        try:
            s.connect((host, port))
            return True
        except OSError:
            return False


def start_tunnel(port, protocol="http2", binary="cloudflared", authtoken=None, domain=None, restarts=20, delay=2.0):
    """Returns (process, box, event). box['url'] holds the public URL once it appears.

    A dropped tunnel is restarted automatically; box['on_url'] reports every new URL.
    """
    is_ngrok = "ngrok" in binary.lower()
    if is_ngrok:
        args = [
            binary,
            "http",
            f"http://127.0.0.1:{port}",
            *([ "--authtoken", str(authtoken)] if authtoken else []),
            *([ "--domain", str(domain)] if domain else []),
            "--log",
            "stdout",
        ]
        pattern = NGROK_URL_RE
    else:
        args = [binary, "tunnel", "--url", f"http://127.0.0.1:{port}", "--protocol", protocol]
        pattern = URL_RE
    box = {}
    event = threading.Event()
    listeners = []
    state = {"attempt": 0}

    def spawn():
        proc = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        def reader():
            for line in proc.stdout:
                match = pattern.search(line)
                if not match:
                    continue
                box["url"] = match.group(0)
                event.set()
                for fn in list(listeners):
                    fn(match.group(0))

        def watcher():
            proc.wait()
            if state["attempt"] < restarts:
                state["attempt"] += 1
                time.sleep(delay)
                spawn()

        threading.Thread(target=reader, daemon=True).start()
        threading.Thread(target=watcher, daemon=True).start()
        return proc

    proc = spawn()
    box["on_url"] = listeners.append
    return proc, box, event
