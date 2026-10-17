"""cloudflared quick-tunnel helper (QUIC is blocked on many networks -> http2 by default)."""

import re
import socket
import subprocess
import threading

URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com", re.IGNORECASE)


def is_port_open(port, host="127.0.0.1", timeout=0.7) -> bool:
    with socket.socket() as s:
        s.settimeout(timeout)
        try:
            s.connect((host, port))
            return True
        except OSError:
            return False


def start_tunnel(port, protocol="http2", binary="cloudflared"):
    """Returns (process, box, event). box['url'] holds the public URL once it appears."""
    proc = subprocess.Popen(
        [binary, "tunnel", "--url", f"http://127.0.0.1:{port}", "--protocol", protocol],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    box = {}
    event = threading.Event()

    def reader():
        for line in proc.stdout:
            match = URL_RE.search(line)
            if match and "url" not in box:
                box["url"] = match.group(0)
                event.set()

    threading.Thread(target=reader, daemon=True).start()
    return proc, box, event
