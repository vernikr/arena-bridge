"""Minimal RFC6455 WebSocket client (standard library only)."""

import base64
import hashlib
import os
import socket
import struct
import threading

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class WebSocketClient:
    def __init__(self, url: str):
        if not url.startswith("ws://"):
            raise ValueError("only ws:// is supported")
        rest = url[len("ws://") :]
        hostport, _, path = rest.partition("/")
        host, _, port = hostport.partition(":")
        self.host = host
        self.port = int(port or 80)
        self.path = "/" + path
        self.sock = None
        self._buffer = b""
        self._lock = threading.Lock()

    def connect(self, timeout: float = 10.0):
        self.sock = socket.create_connection((self.host, self.port), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        request = (
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {self.host}:{self.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(request.encode())

        data = b""
        while b"\r\n\r\n" not in data:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("connection closed during handshake")
            data += chunk
        head, _, rest = data.partition(b"\r\n\r\n")
        expected = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
        if expected.lower().encode() not in head.lower():
            raise ConnectionError("invalid websocket handshake")
        self._buffer = rest
        # The handshake timeout must not outlive the handshake — recv() sets
        # its own per-call timeout, and an idle DevTools socket must stay open
        # between agent actions.
        try:
            self.sock.settimeout(None)
            self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        except Exception:
            pass
        return self

    def _read_exact(self, n: int) -> bytes:
        out = b""
        while len(out) < n:
            chunk = self.sock.recv(n - len(out))
            if not chunk:
                raise ConnectionError("connection closed")
            out += chunk
        return out

    def _recv_frame(self):
        b0, b1 = self._read_exact(2)
        fin = bool(b0 & 0x80)
        opcode = b0 & 0x0F
        masked = bool(b1 & 0x80)
        length = b1 & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._read_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._read_exact(8))[0]
        mask = self._read_exact(4) if masked else None
        payload = self._read_exact(length) if length else b""
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return fin, opcode, payload

    def recv(self, timeout: float = 30.0) -> str:
        """Return the next complete text message (reassembling fragments)."""
        deadline = timeout
        fragments = []
        while True:
            self.sock.settimeout(deadline)
            fin, opcode, payload = self._recv_frame()
            if opcode == 0x8:
                raise ConnectionError("closed by peer")
            if opcode == 0x9:  # ping -> pong
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:
                continue
            fragments.append(payload)
            if fin:
                return b"".join(fragments).decode("utf-8", "replace")

    def send(self, text: str):
        self._send_frame(0x1, str(text).encode("utf-8"))

    def _send_frame(self, opcode: int, payload: bytes):
        length = len(payload)
        header = bytearray()
        header.append(0x80 | opcode)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header += struct.pack("!H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack("!Q", length)
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        with self._lock:
            self.sock.sendall(bytes(header) + mask + masked)

    def close(self):
        try:
            self._send_frame(0x8, b"")
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass
