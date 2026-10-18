/**
 * End-to-end smoke test: direct mode, approval gate, MCP endpoint, hub mode.
 * Run with: node test/smoke.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-bridge-test-'));
process.env.ARENA_BRIDGE_HOME = path.join(TMP, 'home');
fs.mkdirSync(process.env.ARENA_BRIDGE_HOME, { recursive: true });

const { loadConfig, saveConfig, DEFAULTS, CONFIG_DIR } = await import('../src/config.mjs');
assert.ok(CONFIG_DIR.startsWith(os.tmpdir()), 'the test must not touch the real configuration');
const { Engine } = await import('../src/engine.mjs');
const { createDirectServer } = await import('../src/direct.mjs');
const { createHubServer } = await import('../src/hub.mjs');
const { runDevice } = await import('../src/device.mjs');
const { listApprovals, decide } = await import('../src/approvals.mjs');
const { startTunnel, isPortOpen } = await import('../src/tunnel.mjs');
const { saveTrust, clearTrust, trustState, trustAllows, parseDuration } = await import('../src/trust.mjs');

const WORK = path.join(TMP, 'work');
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(WORK, 'hello.txt'), 'hello world\n');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

const cfg = {
  ...DEFAULTS,
  mode: 'direct',
  host: '127.0.0.1',
  port: 0,
  token: 'test-agent-token',
  deviceToken: 'test-device-token',
  localToken: 'test-local-token',
  device: 'testbox',
  roots: [WORK],
  protected: [path.join(TMP, 'secret')],
  requireApproval: false,
  approvalWaitSec: 5,
  publicUrl: 'https://example.test',
};
fs.mkdirSync(path.join(TMP, 'secret'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'secret', 'key.pem'), 'PRIVATE');

saveConfig(cfg);
const loaded = loadConfig();
assert.equal(loaded.token, 'test-agent-token');

const engine = new Engine(loaded, { base: WORK });
const server = createDirectServer(loaded, engine);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const auth = { Authorization: `Bearer ${loaded.token}` };

console.log('\n▸ direct mode');

await test('GET /health works without auth', async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
});

await test('GET /tools requires auth', async () => {
  const r = await fetch(`${base}/tools`);
  assert.equal(r.status, 401);
});

await test('GET /tools returns the catalog', async () => {
  const r = await fetch(`${base}/tools`, { headers: auth });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.tools.length >= 14, `expected >=14 tools, got ${j.tools.length}`);
  assert.ok(j.tools.find((t) => t.name === 'bash'));
  assert.ok(j.tools.find((t) => t.name === 'read_file'));
});

await test('a rotated token takes effect without restarting the server', async () => {
  saveConfig({ ...loaded, token: 'rotated-token-xyz' });

  const withOld = await fetch(`${base}/tools`, { headers: auth });
  assert.equal(withOld.status, 401, 'the old token must stop working immediately');

  const withNew = await fetch(`${base}/tools`, {
    headers: { Authorization: 'Bearer rotated-token-xyz' },
  });
  assert.equal(withNew.status, 200);

  saveConfig(loaded); // restore
});

await test('a policy change (roots) applies without restarting the server', async () => {
  const other = path.join(TMP, 'other');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'x.txt'), 'x');

  const before = await fetch(`${base}/call`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'read_file', args: { path: path.join(other, 'x.txt') } }),
  });
  const j1 = await before.json();
  assert.equal(j1.error, 'PROTECTED', 'not allowed before the change');

  saveConfig({ ...loaded, roots: [WORK, other] });

  const after = await fetch(`${base}/call`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'read_file', args: { path: path.join(other, 'x.txt') } }),
  });
  const j2 = await after.json();
  saveConfig(loaded); // restore
  assert.equal(j2.ok, true, 'the new root should be reachable without a restart');
  assert.equal(j2.content, 'x');
});

await test('GET /prompt contains the base url and the token', async () => {
  const r = await fetch(`${base}/prompt`, { headers: auth });
  const text = await r.text();
  assert.ok(text.includes('https://example.test'));
  assert.ok(text.includes(loaded.token));
});

await test('read_file reads a file inside the root', async () => {
  const r = await fetch(`${base}/call`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'read_file', args: { path: path.join(WORK, 'hello.txt') } }),
  });
  const j = await r.json();
  assert.equal(j.ok, true, JSON.stringify(j));
  assert.equal(j.content, 'hello world\n');
});

await test('read_file outside the roots is PROTECTED', async () => {
  const r = await fetch(`${base}/call`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'read_file', args: { path: '/etc/hostname' } }),
  });
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.equal(j.error, 'PROTECTED');
});

await test('read_file of a protected path is PROTECTED', async () => {
  const r = await fetch(`${base}/call`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'read_file', args: { path: path.join(TMP, 'secret', 'key.pem') } }),
  });
  const j = await r.json();
  assert.equal(j.error, 'PROTECTED');
});

await test('list_dir and search_files work', async () => {
  const r1 = await fetch(`${base}/call`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'list_dir', args: { path: WORK } }),
  });
  const j1 = await r1.json();
  assert.equal(j1.ok, true);
  assert.ok(j1.entries.find((e) => e.name === 'hello.txt'));

  const r2 = await fetch(`${base}/call`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'search_files', args: { path: WORK, query: 'hello' } }),
  });
  const j2 = await r2.json();
  assert.equal(j2.ok, true);
  assert.equal(j2.results.length, 1);
});

await test('bash executes a command', async () => {
  const r = await fetch(`${base}/exec`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'echo smoke-ok' }),
  });
  const j = await r.json();
  assert.equal(j.ok, true, JSON.stringify(j));
  assert.match(j.stdout, /smoke-ok/);
  assert.equal(j.exit_code, 0);
});

await test('files API supports GET/PUT/DELETE', async () => {
  const target = path.join(WORK, 'blob.bin');
  const put = await fetch(`${base}/files?path=${encodeURIComponent(target)}`, {
    method: 'PUT',
    headers: auth,
    body: 'binary-ish',
  });
  assert.equal(put.status, 200);
  const get = await fetch(`${base}/files?path=${encodeURIComponent(target)}`, { headers: auth });
  assert.equal(await get.text(), 'binary-ish');
  const del = await fetch(`${base}/files?path=${encodeURIComponent(target)}`, {
    method: 'DELETE',
    headers: auth,
  });
  assert.equal(del.status, 200);
  assert.ok(!fs.existsSync(target));
});

await test('MCP initialize / tools/list / tools/call work', async () => {
  const rpc = async (method, params, id) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    return r.json();
  };
  const init = await rpc('initialize', {}, 1);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  const list = await rpc('tools/list', {}, 2);
  assert.ok(list.result.tools.length >= 14);
  const call = await rpc('tools/call', { name: 'sysinfo', arguments: {} }, 3);
  assert.equal(call.result.isError, false);
  assert.ok(call.result.content[0].text.includes('hostname'));
});

await test('the log and its artifacts are served over HTTP', async () => {
  const r = await fetch(`${base}/call`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'list_dir', args: { path: '.' } }),
  });
  assert.equal((await r.json()).ok, true);
  const log = await fetch(`${base}/audit?limit=5`, { headers: auth });
  const j = await log.json();
  assert.equal(j.ok, true);
  assert.ok(j.entries.length >= 1, 'the log has entries');
  assert.ok(j.entries[0].id, 'entries carry an id');
  const bad = await fetch(`${base}/audit/artifact?entry=nope&file=x.png`, { headers: auth });
  assert.equal(bad.status, 404);
});

console.log('\n▸ approval gate');

const cfgApproval = { ...loaded, requireApproval: true, approvalWaitSec: 10 };
saveConfig(cfgApproval); // the engine reads the policy from disk, so persist it
const engine2 = new Engine(cfgApproval, { base: WORK });
const server2 = createDirectServer(cfgApproval, engine2);
await new Promise((r) => server2.listen(0, '127.0.0.1', r));
const base2 = `http://127.0.0.1:${server2.address().port}`;

await test('side-effecting tool without approval is refused', async () => {
  const p = fetch(`${base2}/call`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'bash', args: { command: 'echo should-not-run' } }),
  }).then((r) => r.json());

  // wait for the request to be registered, then approve it like a human would
  let pending = null;
  for (let i = 0; i < 40 && !pending; i++) {
    await new Promise((r) => setTimeout(r, 200));
    pending = listApprovals().find((a) => a.status === 'pending' && a.tool === 'bash');
  }
  assert.ok(pending, 'no pending approval was created');
  assert.ok(JSON.stringify(pending.args).includes('should-not-run'));
  const decided = decide(pending.id, 'approve', 'test');
  assert.equal(decided.ok, true);

  const j = await p;
  assert.equal(j.ok, true, JSON.stringify(j));
  assert.match(j.stdout, /should-not-run/);
});

await test('read-only tools need no approval', async () => {
  const r = await fetch(`${base2}/call`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'sysinfo', args: {} }),
  });
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(listApprovals().filter((a) => a.status === 'pending').length, 0);
});

await test('denied approval blocks the tool', async () => {
  const p = fetch(`${base2}/call`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'bash', args: { command: 'echo denied-case' } }),
  }).then((r) => r.json());

  let pending = null;
  for (let i = 0; i < 40 && !pending; i++) {
    await new Promise((r) => setTimeout(r, 200));
    pending = listApprovals().find((a) => a.status === 'pending' && a.tool === 'bash');
  }
  assert.ok(pending);
  decide(pending.id, 'deny', 'test');
  const j = await p;
  assert.equal(j.ok, false);
  assert.equal(j.error, 'APPROVAL_DENIED');
  assert.equal(j.pending, false);
});

saveConfig(loaded); // back to the default policy for the remaining tests

await test('a symlinked root still matches its files', async () => {
  const { checkPath } = await import('../src/policy.mjs');
  const real = path.join(TMP, 'real-root');
  const link = path.join(TMP, 'link-root');
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, 'inside.txt'), 'x');
  try {
    fs.symlinkSync(real, link, 'dir');
  } catch {
    return; // symlinks are not available here
  }
  const res = checkPath(path.join(link, 'inside.txt'), { roots: [link], protected: [] });
  assert.equal(res.ok, true, JSON.stringify(res));
});

console.log('\n▸ approvals over HTTP');

await test('the local token settles a request, the agent token cannot', async () => {
  const id = 'aaaaaaaa-1111-2222-3333-444444444444';
  const dir = path.join(CONFIG_DIR, 'approvals');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      tool: 'bash',
      args: {},
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000,
      decidedAt: null,
      decidedBy: null,
    }),
  );
  const refused = await fetch(`${base}/approvals/${id}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'approve' }),
  });
  assert.equal(refused.status, 403, 'the agent must not approve itself');
  const allowed = await fetch(`${base}/approvals/${id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${loaded.localToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'approve' }),
  });
  assert.equal(allowed.status, 200);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
  assert.equal(rec.status, 'approved');
});

console.log('\n▸ trust window');

saveConfig({ ...loaded, requireApproval: true }); // approvals are on, only trust can lift them

await test('an open trust window removes the approval requirement', async () => {
  saveTrust({ enabled: true, until: Date.now() + 3600_000, tools: [], paths: [], createdAt: Date.now() });
  const r = await fetch(`${base}/call`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'bash', args: { command: 'echo trusted' } }),
  });
  const j = await r.json();
  assert.equal(j.ok, true, JSON.stringify(j));
  assert.match(j.stdout, /trusted/);
  clearTrust();
});

await test('a tool-scoped trust window covers only the listed tools', async () => {
  saveTrust({
    enabled: true,
    until: Date.now() + 3600_000,
    tools: ['write_file'],
    paths: [],
    createdAt: Date.now(),
  });
  const target = path.join(WORK, 'trusted.txt');
  const write = await fetch(`${base}/call`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'write_file', args: { path: target, content: 'ok' } }),
  });
  assert.equal((await write.json()).ok, true, 'write_file is trusted');

  const bash = await fetch(`${base}/call`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'bash', args: { command: 'echo nope' } }),
  });
  const j = await bash.json();
  assert.equal(j.ok, false);
  assert.equal(j.error, 'APPROVAL_PENDING', 'bash is not in the trust list');
  clearTrust();
});

await test('a path-scoped trust window only covers paths inside it', async () => {
  // the trust window lifts the approval requirement; the roots policy still applies
  const inside = path.join(WORK, 'inside');
  const outside = path.join(WORK, 'outside');
  fs.mkdirSync(inside, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  saveTrust({
    enabled: true,
    until: Date.now() + 3600_000,
    tools: [],
    paths: [inside],
    createdAt: Date.now(),
  });

  const okWrite = await fetch(`${base}/call`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'write_file', args: { path: path.join(inside, 'a.txt'), content: 'x' } }),
  });
  const okJson = await okWrite.json();
  assert.equal(okJson.ok, true, 'paths inside the trust scope are allowed');

  const badWrite = await fetch(`${base}/call`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'write_file', args: { path: path.join(outside, 'b.txt'), content: 'x' } }),
  });
  const j = await badWrite.json();
  assert.equal(j.ok, false);
  assert.equal(j.error, 'APPROVAL_PENDING', 'paths outside the trust scope still need approval');
  clearTrust();
});

await test('an expired trust window no longer applies', async () => {
  saveTrust({ enabled: true, until: Date.now() - 1000, tools: [], paths: [], createdAt: Date.now() });
  const r = await fetch(`${base}/call`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'bash', args: { command: 'echo expired' } }),
  });
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.equal(j.error, 'APPROVAL_PENDING');
  assert.equal(j.pending, true);
  clearTrust();
});

saveConfig(loaded); // back to the default policy for the remaining tests

console.log('\n▸ hub mode');

const hubCfg = {
  ...loaded,
  mode: 'hub',
  port: 0,
  device: 'testbox',
  deviceToken: 'test-device-token',
  requireApproval: false,
};
const hub = createHubServer(hubCfg);
await new Promise((r) => hub.listen(0, '127.0.0.1', r));
const hubBase = `http://127.0.0.1:${hub.address().port}`;
hubCfg.hub = hubBase;

const deviceEngine = new Engine(hubCfg, { base: WORK });
const stop = { done: false };
const devicePromise = runDevice(hubCfg, deviceEngine, { log: () => {} }).catch(() => {});
await new Promise((r) => setTimeout(r, 700));

await test('hub reports the device as online', async () => {
  const r = await fetch(`${hubBase}/devices`, { headers: auth });
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.devices.length, 1);
  assert.equal(j.devices[0].name, 'testbox');
  assert.equal(j.devices[0].online, true);
});

await test('agent call is forwarded to the device and executed there', async () => {
  const r = await fetch(`${hubBase}/call`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'bash', args: { command: 'echo from-device' } }),
  });
  const j = await r.json();
  assert.equal(j.ok, true, JSON.stringify(j));
  assert.match(j.stdout, /from-device/);
});

await test('device token cannot use the agent API', async () => {
  const r = await fetch(`${hubBase}/call`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-device-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'bash', args: { command: 'echo escalation' } }),
  });
  assert.equal(r.status, 401);
});

await test('hub rejects an unknown device', async () => {
  const r = await fetch(`${hubBase}/call`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'bash', args: { device: 'ghost', command: 'echo nope' } }),
  });
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.equal(j.error, 'DEVICE_OFFLINE');
});

hub.gracefulStop?.();
hub.close();
server.close();
server2.close();

console.log('\n▸ tunnel helper');

await test('startTunnel extracts the public URL from the cloudflared banner', async () => {
  const fake = path.join(TMP, 'fake-cloudflared');
  fs.writeFileSync(
    fake,
    [
      '#!/bin/sh',
      'echo "2026-01-01T00:00:00Z INF +-------------------------------------+"',
      'echo "2026-01-01T00:00:00Z INF |  Your quick Tunnel has been created!        |"',
      'echo "2026-01-01T00:00:00Z INF |  https://fake-quick-tunnel.trycloudflare.com |"',
      'sleep 30',
    ].join('\n'),
    { mode: 0o755 },
  );
  const { child, urlPromise } = startTunnel(loaded, { port: 8787, bin: fake });
  const url = await urlPromise;
  assert.equal(url, 'https://fake-quick-tunnel.trycloudflare.com');
  child.kill();
});

await test('a dropped tunnel is restarted and the new URL is reported', async () => {
  const log = path.join(TMP, 'tunnel-restart.log');
  const fake = path.join(TMP, 'fake-flaky-tunnel');
  fs.writeFileSync(
    fake,
    [
      '#!/bin/sh',
      'echo "start $$" >> "' + log + '"',
      'echo "2026-01-01T00:00:00Z INF https://fake-flaky-tunnel.trycloudflare.com"',
      'exit 1',
    ].join('\n'),
    { mode: 0o755 },
  );
  const { child, urlPromise, onUrl } = startTunnel(loaded, { port: 8787, bin: fake, delay: 100 });
  const url = await urlPromise;
  assert.equal(url, 'https://fake-flaky-tunnel.trycloudflare.com');
  const seen = [];
  onUrl((u) => seen.push(u));
  await new Promise((r) => setTimeout(r, 1200));
  const starts = fs.readFileSync(log, 'utf8').trim().split('\n').length;
  assert.ok(starts >= 2, `expected the tunnel to restart, got ${starts} start(s)`);
  assert.ok(seen.length >= 1, 'the new URL is reported');
  child.kill();
});

await test('repeated --root flags accumulate instead of overwriting', async () => {
  const { parseArgs } = await import('../src/cli.mjs');
  const args = parseArgs(['init', '--root', '~/projects', '--root', '~/Documents,~/notes']);
  assert.deepEqual(args.flags.root, ['~/projects', '~/Documents,~/notes']);
  const flat = args.flags.root.flatMap((v) => v.split(',')).map((v) => v.trim());
  assert.deepEqual(flat, ['~/projects', '~/Documents', '~/notes']);
});

await test('the service command takes the tunnel flags', async () => {
  const { parseArgs } = await import('../src/cli.mjs');
  const args = parseArgs(['service', 'install', '--bin', 'ngrok', '--domain', 'mymac.ngrok-free.app']);
  assert.equal(args.flags.bin, 'ngrok');
  assert.equal(args.flags.domain, 'mymac.ngrok-free.app');
});

await test('the app name is the same in node, python and swift', async () => {
  const { APP_NAME, APP_ID } = await import('../src/app.mjs');
  const python = fs.readFileSync(new URL('../arena_bridge/app.py', import.meta.url), 'utf8');
  const swift = fs.readFileSync(new URL('../macos/ArenaBridge/Sources/AppInfo.swift', import.meta.url), 'utf8');
  const pick = (text, key) => (text.match(new RegExp(`${key} = "([^"]+)"`)) || [])[1];
  const pickSwift = (text, key) => (text.match(new RegExp(`${key} = "([^"]+)"`)) || [])[1];
  assert.equal(pick(python, 'APP_NAME'), APP_NAME);
  assert.equal(pick(python, 'APP_ID'), APP_ID);
  assert.equal(pickSwift(swift, 'name'), APP_NAME);
  assert.equal(pickSwift(swift, 'bundleID'), APP_ID);
});

await test('the background service starts the app, not the node binary', async () => {
  const { plistXml, runnerPath } = await import('../src/service.mjs');
  const xml = plistXml({});
  assert.ok(xml.includes(`<string>${runnerPath()}</string>`), xml);
  assert.ok(!xml.includes(process.execPath), 'the node binary must not be the entry point');
});

await test('isPortOpen detects a listening port', async () => {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const p = probe.address().port;
  assert.equal(await isPortOpen(p), true);
  assert.equal(await isPortOpen(1), false);
  probe.close();
});

console.log(`\n${passed} passed, ${failed} failed\n`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
