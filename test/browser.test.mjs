/**
 * Browser stack tests: WebSocket client → CDP client → browser tools,
 * against the fake CDP server in test/fake-cdp.mjs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { spawn } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-bridge-browser-'));
process.env.ARENA_BRIDGE_HOME = path.join(TMP, 'home');
fs.mkdirSync(process.env.ARENA_BRIDGE_HOME, { recursive: true });

const { loadConfig, saveConfig, DEFAULTS } = await import('../src/config.mjs');
const { Engine } = await import('../src/engine.mjs');
const { CDPClient, browserWsUrl } = await import('../src/cdp.mjs');
const { WebSocketClient } = await import('../src/ws.mjs');

const PORT = 9300 + Math.floor(Math.random() * 200);
const FAKE = path.join(process.cwd(), 'test', 'fake-cdp.mjs');
const FAKE_CHROME = path.join(process.cwd(), 'test', 'fake-chrome.sh');
fs.chmodSync(FAKE_CHROME, 0o755);

const fake = spawn('node', [FAKE, '--port', String(PORT)], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) {
  await sleep(100);
  try {
    await browserWsUrl(PORT);
    break;
  } catch {
    /* not up yet */
  }
}

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
  token: 'browser-test-token',
  deviceToken: 'browser-test-device',
  localToken: 'browser-test-local',
  device: 'browserbox',
  roots: [TMP],
  protected: [path.join(TMP, 'secret')],
  requireApproval: false,
  approvalWaitSec: 3,
};
saveConfig(cfg);
const engine = new Engine(cfg, { base: TMP });

console.log('\n▸ websocket client');

await test('handshake + echo over a real socket', async () => {
  const ws = new WebSocketClient(`ws://127.0.0.1:${PORT}/devtools/browser/fake`);
  await ws.connect();
  const got = new Promise((resolve) => ws.once('message', (m) => resolve(m)));
  ws.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
  const msg = JSON.parse(await got);
  assert.equal(msg.id, 1);
  assert.equal(msg.result.targetInfos.length, 2);
  ws.close();
});

await test('large payloads survive in both directions', async () => {
  const ws = new WebSocketClient(`ws://127.0.0.1:${PORT}/devtools/browser/fake`);
  ws.on('error', () => {});
  await ws.connect();

  // send a large command
  const got = new Promise((resolve) => ws.once('message', (m) => resolve(m)));
  ws.send(JSON.stringify({ id: 7, method: 'Fake.large', params: { pad: 'x'.repeat(200000) } }));
  const msg = JSON.parse(await got);
  assert.equal(msg.result.data.length, 300000);
  ws.close();
});

console.log('\n▸ cdp client');

await test('send() resolves with the command result', async () => {
  const cdp = new CDPClient(`ws://127.0.0.1:${PORT}/devtools/browser/fake`);
  await cdp.connect();
  const res = await cdp.send('Target.getTargets');
  assert.equal(res.targetInfos[0].url, 'https://example.com/');
  cdp.close();
});

console.log('\n▸ browser tools');

await test('the catalog exposes the chrome_* tools', async () => {
  const names = engine.catalog().map((t) => t.name);
  for (const n of [
    'chrome_launch',
    'chrome_attach',
    'chrome_tabs',
    'chrome_open',
    'chrome_navigate',
    'chrome_snapshot',
    'chrome_click',
    'chrome_type',
    'chrome_press',
    'chrome_screenshot',
    'chrome_evaluate',
    'chrome_stop',
  ]) {
    assert.ok(names.includes(n), `missing tool ${n}`);
  }
});

await test('chrome_launch starts an agent-owned browser and lists its tabs', async () => {
  process.env.CHROME_PATH = FAKE_CHROME;
  const res = await engine.call('chrome_launch', { headless: true, port: PORT + 1, url: 'https://example.com/' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.managed, true);
  assert.ok(res.session_id.startsWith('chrome_'));
  assert.ok(res.tabs.length >= 2);
  engine.browser.sessions.get(res.session_id)?.proc?.kill();
});

await test('actions on the agent-owned browser need no approval', async () => {
  process.env.CHROME_PATH = FAKE_CHROME;
  const launch = await engine.call('chrome_launch', { headless: true, port: PORT + 2 });
  const session = launch.session_id;
  const open = await engine.call('chrome_open', { session_id: session, url: 'https://example.net/' });
  assert.equal(open.ok, true, JSON.stringify(open));
  const snap = await engine.call('chrome_snapshot', { session_id: session, tab_id: open.tab_id });
  assert.equal(snap.ok, true);
  assert.equal(snap.text, 'Hello from the fake page');
  engine.browser.sessions.get(session)?.proc?.kill();
});

await test('chrome_snapshot returns an accessibility tree in ax mode', async () => {
  process.env.CHROME_PATH = FAKE_CHROME;
  const launch = await engine.call('chrome_launch', { headless: true, port: PORT + 3 });
  const snap = await engine.call('chrome_snapshot', { session_id: launch.session_id, mode: 'ax' });
  assert.equal(snap.ok, true);
  assert.ok(snap.nodes.some((n) => n.name === 'Submit'));
  engine.browser.sessions.get(launch.session_id)?.proc?.kill();
});

await test('chrome_screenshot saves a PNG inside the authorized roots', async () => {
  process.env.CHROME_PATH = FAKE_CHROME;
  const launch = await engine.call('chrome_launch', { headless: true, port: PORT + 4 });
  const target = path.join(TMP, 'shot.png');
  const shot = await engine.call('chrome_screenshot', { session_id: launch.session_id, path: target });
  assert.equal(shot.ok, true, JSON.stringify(shot));
  assert.ok(fs.existsSync(target));
  const buf = fs.readFileSync(target);
  assert.equal(buf[0], 0x89, 'PNG magic');
  engine.browser.sessions.get(launch.session_id)?.proc?.kill();
});

await test('chrome_screenshot refuses paths outside the authorized roots', async () => {
  process.env.CHROME_PATH = FAKE_CHROME;
  const launch = await engine.call('chrome_launch', { headless: true, port: PORT + 5 });
  const shot = await engine.call('chrome_screenshot', {
    session_id: launch.session_id,
    path: '/etc/passwd',
  });
  assert.equal(shot.ok, false);
  assert.equal(shot.error, 'PROTECTED');
  engine.browser.sessions.get(launch.session_id)?.proc?.kill();
});

await test('actions on the user\'s own Chrome require a local approval', async () => {
  const attach = await engine.call('chrome_attach', { port: PORT });
  assert.equal(attach.ok, true, JSON.stringify(attach));
  assert.equal(attach.managed, false);
  assert.ok(attach.tabs.length >= 2);

  // requireApproval is on for attached browsers: the call must be blocked
  const blocked = await engine.call(
    'chrome_click',
    { session_id: attach.session_id, text: 'Submit' },
    { requireApproval: true },
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'APPROVAL_PENDING');
  engine.browser.sessions.get(attach.session_id)?.cdp?.close();
});

await test('chrome_stop refuses to kill an attached user browser', async () => {
  const attach = await engine.call('chrome_attach', { port: PORT });
  const stopped = await engine.call('chrome_stop', { session_id: attach.session_id });
  assert.equal(stopped.ok, false);
  engine.browser.sessions.get(attach.session_id)?.cdp?.close();
});

fake.kill();
console.log(`\n${passed} passed, ${failed} failed\n`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
