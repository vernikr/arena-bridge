/**
 * Device client: connects OUT to the hub (no inbound ports, works behind NAT)
 * and executes the jobs the hub forwards.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry a result while the hub may still be waiting for it. A 404 means the job expired. */
export async function postResult(base, headers, payload, {
  fetchImpl = fetch,
  sleepImpl = sleep,
  log = () => {},
  maxAttempts = 8,
} = {}) {
  let delay = 1000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchImpl(`${base}/device/result`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      if (res.ok) return true;
      if (res.status === 404) return false;
      log(`[device] result failed: HTTP ${res.status} (attempt ${attempt}/${maxAttempts})`);
    } catch (e) {
      log(`[device] result connection error (attempt ${attempt}/${maxAttempts}): ${e.message}`);
    }
    if (attempt < maxAttempts) {
      await sleepImpl(delay);
      delay = Math.min(delay * 2, 30_000);
    }
  }
  return false;
}

export async function runDevice(cfg, engine, { log = console.log } = {}) {
  const base = String(cfg.hub || '').replace(/\/+$/, '');
  if (!base) throw new Error('cfg.hub is required in hub mode');
  if (!cfg.deviceToken) throw new Error('cfg.deviceToken is required in hub mode');

  const headers = {
    Authorization: `Bearer ${cfg.deviceToken}`,
    'Content-Type': 'application/json',
  };

  let backoff = 1000;
  log(`[device] ${cfg.device} -> ${base}`);

  for (;;) {
    try {
      const res = await fetch(`${base}/device/poll`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ device: cfg.device }),
      });

      if (res.status === 204) {
        backoff = 1000;
        await sleep(700);
        continue;
      }
      if (!res.ok) {
        log(`[device] poll failed: HTTP ${res.status}`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
        continue;
      }

      backoff = 1000;
      const job = await res.json();
      log(`[device] job ${job.id} ${job.tool}`);

      let result;
      try {
        result = await engine.call(job.tool, job.args || {}, { source: job.source || { channel: 'hub', ip: null, country: null, host: null, client: null }, actor: job.source?.actor || 'agent' });
      } catch (e) {
        result = { ok: false, error: e.message };
      }

      await postResult(base, headers, { id: job.id, result }, { log });
    } catch (e) {
      log(`[device] connection error: ${e.message}`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}
