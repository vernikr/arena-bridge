/**
 * Device client: connects OUT to the hub (no inbound ports, works behind NAT)
 * and executes the jobs the hub forwards.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

      await fetch(`${base}/device/result`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: job.id, result }),
      });
    } catch (e) {
      log(`[device] connection error: ${e.message}`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}
