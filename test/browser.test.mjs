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

const { loadConfig, saveConfig, DEFAULTS , CONFIG_DIR } = await import('../src/config.mjs');
assert.ok(CONFIG_DIR.startsWith(os.tmpdir()), 'the test must not touch the real configuration');
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

await test('an idle connection survives past the handshake timeout', async () => {
  const cdp = new CDPClient(`ws://127.0.0.1:${PORT}/devtools/browser/fake`);
  await cdp.connect(250);
  await sleep(700); // > handshake timeout, no traffic at all
  const res = await cdp.send('Target.getTargets');
  assert.equal(res.targetInfos.length, 2);
  cdp.close();
});

console.log('\n▸ browser tools');

await test('the catalog exposes the chrome_* tools', async () => {
  const names = engine.catalog().map((t) => t.name);
  for (const n of [
    'chrome_launch',
    'chrome_profiles',
    'chrome_attach',
    'chrome_tabs',
    'chrome_activate',
    'chrome_open',
    'chrome_navigate',
    'chrome_snapshot',
    'chrome_observe',
    'chrome_fill_editor',
    'chrome_wait_for',
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

await test('a named profile keeps its logins between runs', async () => {
  process.env.CHROME_PATH = FAKE_CHROME;
  const res = await engine.call('chrome_launch', { headless: true, port: PORT + 9, profile: 'work' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.profile_name, 'work');
  assert.ok(res.profile.endsWith(path.join('chrome-profiles', 'work')), res.profile);
  engine.browser.sessions.get(res.session_id)?.proc?.kill();
});

await test('chrome_profiles lists the named profiles', async () => {
  const res = await engine.call('chrome_profiles', {});
  assert.equal(res.ok, true);
  assert.ok(res.profiles.some((p) => p.name === 'work'), JSON.stringify(res.profiles));
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

await test('chrome_observe + click by ref + fill_editor + wait_for', async () => {
  process.env.CHROME_PATH = FAKE_CHROME;
  const launch = await engine.call('chrome_launch', { headless: true, port: PORT + 6, profile: 'observe' });
  const sid = launch.session_id;
  const obs = await engine.call('chrome_observe', { session_id: sid });
  assert.equal(obs.ok, true, JSON.stringify(obs));
  assert.ok(obs.snapshot_id);
  assert.equal(obs.elements[0].name, 'Submit');
  assert.equal(obs.composer.kind, 'contenteditable');
  const click = await engine.call('chrome_click', { session_id: sid, ref: 'el_0', snapshot_id: obs.snapshot_id });
  assert.equal(click.ok, true, JSON.stringify(click));
  const stale = await engine.call('chrome_click', { session_id: sid, ref: 'el_0', snapshot_id: 'snap_old' });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'stale_ref');
  const fill = await engine.call('chrome_fill_editor', { session_id: sid, text: 'hello' });
  assert.equal(fill.ok, true, JSON.stringify(fill));
  assert.equal(fill.value, 'typed');
  const wait = await engine.call('chrome_wait_for', { session_id: sid, condition: { type: 'text_present', text: 'Hello' } });
  assert.equal(wait.verified, true);
  const snap = await engine.call('chrome_snapshot', { session_id: sid, mode: 'ax' });
  assert.equal(snap.nodes.find((n) => n.name === 'Submit').state.pressed, false);
  const profiles = await engine.call('chrome_profiles', {});
  assert.equal(profiles.profiles.find((x) => x.name === 'observe').running, true);
  engine.browser.sessions.get(sid)?.proc?.kill();
});

await test('a dropped DevTools socket reconnects and keeps the session', async () => {
  process.env.CHROME_PATH = FAKE_CHROME;
  const launch = await engine.call('chrome_launch', { headless: true, port: PORT + 10, profile: 'reconnect' });
  assert.equal(launch.ok, true, JSON.stringify(launch));
  const sid = launch.session_id;
  const s = engine.browser.sessions.get(sid);
  s.cdp.ws.socket.destroy(); // simulate Chrome dropping an idle DevTools socket
  for (let i = 0; i < 50 && !(engine.browser.sessions.get(sid)?.reconnects >= 1); i++) {
    await sleep(100);
  }
  const after = engine.browser.sessions.get(sid);
  assert.ok(after, 'session must survive a dropped socket');
  assert.equal(after.disconnected, false);
  assert.ok(after.reconnects >= 1, 'session must have reconnected');
  const tabs = await engine.call('chrome_tabs', { session_id: sid });
  assert.equal(tabs.ok, true, JSON.stringify(tabs));
  assert.ok(tabs.tabs.length >= 2);
  const act = await engine.call('chrome_activate', { session_id: sid, tab_id: tabs.tabs[0].tab_id });
  assert.equal(act.ok, true, JSON.stringify(act));
  engine.browser.sessions.get(sid)?.proc?.kill();
});

await test('a second launch of a running profile is refused as profile_busy', async () => {
  process.env.CHROME_PATH = FAKE_CHROME;
  const first = await engine.call('chrome_launch', { headless: true, port: PORT + 7, profile: 'busy' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await engine.call('chrome_launch', { headless: true, port: PORT + 8, profile: 'busy' });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'profile_busy');
  await engine.call('chrome_stop', { session_id: first.session_id });
});

await test('the human login launch carries no debugging/automation flags', async () => {
  for (const f of ['src/cli.mjs', 'arena_bridge/cli.py']) {
    const src = fs.readFileSync(path.join(process.cwd(), f), 'utf8');
    assert.ok(!src.includes('--remote-debugging-port=0'), `${f} must not start the login browser with a debugging port`);
    assert.ok(src.includes('browser login'), `${f} must expose "browser login"`);
  }
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
