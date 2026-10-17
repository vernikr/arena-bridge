"""Device client: connects OUT to the hub (no inbound ports, works behind NAT)."""

import json
import time
import urllib.error
import urllib.request


def run_device(cfg, engine, log=print):
    base = str(cfg.get("hub") or "").rstrip("/")
    if not base:
        raise ValueError("hub URL is required in hub mode")
    token = cfg.get("deviceToken")
    if not token:
        raise ValueError("deviceToken is required in hub mode")

    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    device = cfg.get("device")
    backoff = 1.0
    log(f"[device] {device} -> {base}")

    while True:
        try:
            req = urllib.request.Request(
                f"{base}/device/poll",
                data=json.dumps({"device": device}).encode(),
                headers=headers,
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=120) as resp:
                if resp.status == 204:
                    backoff = 1.0
                    time.sleep(0.7)
                    continue
                job = json.loads(resp.read().decode())

            backoff = 1.0
            log(f"[device] job {job.get('id')} {job.get('tool')}")
            try:
                result = engine.call(job.get("tool"), job.get("args") or {})
            except Exception as e:
                result = {"ok": False, "error": str(e)}

            req2 = urllib.request.Request(
                f"{base}/device/result",
                data=json.dumps({"id": job.get("id"), "result": result}, default=str).encode(),
                headers=headers,
                method="POST",
            )
            urllib.request.urlopen(req2, timeout=120).read()
        except urllib.error.HTTPError as e:
            log(f"[device] poll failed: HTTP {e.code}")
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)
        except Exception as e:
            log(f"[device] connection error: {e}")
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)
