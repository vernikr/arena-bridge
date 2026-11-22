import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRemoteHealth, classifyHealthError, startRemoteMonitor } from '../src/monitor.mjs';

function healthyResponse() {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null, has: () => false },
    json: async () => ({ ok: true, mode: 'direct' }),
  };
}

test('remote health checks local API and public HTTPS endpoint independently', async () => {
  const urls = [];
  const result = await checkRemoteHealth({
    localUrl: 'http://127.0.0.1:8787/health',
    publicUrl: 'https://bridge.example.test',
    fetchImpl: async (url) => { urls.push(url); return healthyResponse(); },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map((c) => c.name), ['local_api', 'public_endpoint']);
  assert.equal(urls[1], 'https://bridge.example.test/health');
});

test('remote health identifies DNS and Cloudflare edge failures', async () => {
  const dnsError = Object.assign(new Error('getaddrinfo EAI_AGAIN bridge.example.test'), { code: 'EAI_AGAIN' });
  assert.equal(classifyHealthError(dnsError).code, 'dns');
  const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  assert.equal(classifyHealthError(refused, 'local_api').code, 'local_api_unavailable');
  assert.equal(classifyHealthError(refused, 'public_endpoint').code, 'edge_connectivity');

  const result = await checkRemoteHealth({
    localUrl: 'http://127.0.0.1:8787/health',
    publicUrl: 'https://bridge.example.test',
    fetchImpl: async (url) => {
      if (String(url).startsWith('http://')) return healthyResponse();
      return {
        ok: false,
        status: 530,
        statusText: 'Origin DNS error',
        headers: { get: () => 'cloudflare', has: () => true },
      };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks[0].ok, true);
  assert.equal(result.checks[1].code, 'cloudflare_edge');
  assert.match(result.checks[1].hint, /named tunnel/);
});

test('monitor alerts after three failures and sends a recovery notification', async () => {
  let online = false;
  const notifications = [];
  const fetchImpl = async () => {
    if (!online) throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    return healthyResponse();
  };
  const monitor = startRemoteMonitor({
    localUrl: 'http://127.0.0.1:8787/health',
    publicUrl: 'https://bridge.example.test',
    intervalMs: 1_000_000,
    failureThreshold: 3,
    fetchImpl,
    notify: async (message) => { notifications.push(message); return { ok: true }; },
    runImmediately: false,
  });
  try {
    await monitor.check();
    await monitor.check();
    assert.equal(notifications.length, 0);
    await monitor.check();
    assert.equal(notifications.length, 1);
    assert.match(notifications[0], /3 последовательных проверок/);
    online = true;
    await monitor.check();
    assert.equal(notifications.length, 2);
    assert.match(notifications[1], /снова доступен/);
    assert.deepEqual(monitor.status(), { failures: 0, alerted: false, running: false, stopped: false });
  } finally {
    monitor.stop();
  }
});
