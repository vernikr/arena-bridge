"""Minimal Chrome DevTools Protocol client (standard library only)."""

import json
import queue
import threading
import urllib.request

from .ws import WebSocketClient


class CDPError(RuntimeError):
    pass


class CDPClient:
    def __init__(self, ws_url: str):
        self.ws_url = ws_url
        self.ws = None
        self._id = 0
        self._responses = {}
        self._lock = threading.Lock()
        self._events = queue.Queue()
        self._reader = None
        self._closed = False

    def connect(self, timeout: float = 10.0):
        self.ws = WebSocketClient(self.ws_url).connect(timeout=timeout)
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()
        return self

    def _read_loop(self):
        try:
            while not self._closed:
                text = self.ws.recv(timeout=120)
                msg = json.loads(text)
                if "id" in msg:
                    with self._lock:
                        self._responses[msg["id"]] = msg
                else:
                    self._events.put(msg)
        except Exception:
            self._closed = True

    def send(self, method: str, params=None, session_id=None, timeout: float = 30.0):
        if not self.ws or self._closed:
            raise CDPError("devtools not connected")
        with self._lock:
            self._id += 1
            msg_id = self._id
        payload = {"id": msg_id, "method": method, "params": params or {}}
        if session_id:
            payload["sessionId"] = session_id
        self.ws.send(json.dumps(payload))

        deadline = timeout
        step = 0.05
        waited = 0.0
        while waited < deadline:
            with self._lock:
                msg = self._responses.pop(msg_id, None)
            if msg is not None:
                if "error" in msg:
                    raise CDPError(msg["error"].get("message", "devtools error"))
                return msg.get("result") or {}
            threading.Event().wait(step)
            waited += step
        raise CDPError(f"timeout waiting for {method}")

    def close(self):
        self._closed = True
        try:
            self.ws.close()
        except Exception:
            pass


def browser_ws_url(port: int = 9222, host: str = "127.0.0.1", timeout: float = 5.0):
    with urllib.request.urlopen(f"http://{host}:{port}/json/version", timeout=timeout) as resp:
        data = json.loads(resp.read().decode())
    if "webSocketDebuggerUrl" not in data:
        raise RuntimeError("no webSocketDebuggerUrl in /json/version")
    return data["webSocketDebuggerUrl"]
