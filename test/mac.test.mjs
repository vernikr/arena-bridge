/**
 * Desktop control (macOS via Peekaboo) + the listing fix that keeps the agent from
 * mistaking a recursive listing for the top level.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const { Engine } = await import(path.join(root, 'src', 'engine.mjs'));
const { loadConfig, saveConfig, CONFIG_DIR, DEFAULTS } = await import(path.join(root, 'src', 'config.mjs'));

const HOME = path.join(os.tmpdir(), `ab-mac-${process.pid}`);
process.env.ARENA_BRIDGE_HOME = HOME;
fs.mkdirSync(HOME, { recursive: true });

const WORK = path.join(HOME, 'work');
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(path.join(WORK, 'nested', 'deep'), { recursive: true });
fs.writeFileSync(path.join(WORK, 'top.txt'), 'x');
fs.writeFileSync(path.join(WORK, 'nested', 'deep', 'inner.txt'), 'y');
fs.writeFileSync(path.join(WORK, '.hidden'), 'z');

const FAKE = path.join(here, 'fake-peekaboo.sh');
fs.chmodSync(FAKE, 0o755);
const LOG = path.join(HOME, 'peek.log');
process.env.PEEKABOO_PATH = FAKE;
process.env.FAKE_PEEKABOO_LOG = LOG;

const cfg = {
  ...DEFAULTS,
  token: 'test-token',
  deviceToken: 'device-token',
  localToken: 'local-token',
  roots: [WORK],
  requireApproval: false,
  approvalWaitSec: 2,
};
saveConfig(cfg);

const engine = new Engine(cfg, { base: WORK });

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

console.log('\n▸ listing');

await test('list_dir returns the top level only by default', async () => {
  const r = await engine.call('list_dir', { path: WORK });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.depth, 0);
  const names = r.entries.map((e) => e.name).sort();
  assert.deepEqual(names, ['.hidden', 'nested', 'top.txt']);
  assert.ok(r.entries.every((e) => e.depth === 0), 'no nested entries');
});

await test('list_dir walks deeper when asked to', async () => {
  const r = await engine.call('list_dir', { path: WORK, recursive: true });
  const names = r.entries.map((e) => e.path);
  assert.ok(names.some((p) => p.endsWith(path.join('nested', 'deep', 'inner.txt'))), JSON.stringify(names));
  assert.ok(r.entries.some((e) => e.depth === 2), 'depth is reported');
});

await test('list_dir can hide dotfiles', async () => {
  const r = await engine.call('list_dir', { path: WORK, include_hidden: false });
  assert.ok(!r.entries.some((e) => e.name === '.hidden'));
});

await test('list_dir reports a readable error for a missing directory', async () => {
  const r = await engine.call('list_dir', { path: path.join(WORK, 'nope') });
  assert.equal(r.ok, false);
  assert.match(r.error, /not found/);
});

console.log('\n▸ desktop control');

await test('the catalog carries the mac_* tools', async () => {
  const names = engine.catalog().map((t) => t.name);
  for (const t of ['mac_see', 'mac_click', 'mac_type', 'mac_key', 'mac_scroll', 'mac_apps', 'mac_windows']) {
    assert.ok(names.includes(t), `missing ${t}`);
  }
});

await test('mac_see captures a screenshot and lists the elements', async () => {
  const r = await engine.call('mac_see', { path: path.join(WORK, 'shot.png') });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.saved, true);
  assert.equal(r.element_count, 2);
  assert.equal(r.elements[0].id, 'B1');
  assert.equal(r.elements[0].title, 'Save');
  assert.ok(fs.existsSync(path.join(WORK, 'shot.png')));
});

await test('mac_click passes the element id to peekaboo', async () => {
  const r = await engine.call('mac_click', { on: 'B1', app: 'Safari' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const log = fs.readFileSync(LOG, 'utf8');
  assert.match(log, /click --on B1 --app Safari/);
});

await test('mac_type and mac_key reach the desktop', async () => {
  assert.equal((await engine.call('mac_type', { text: 'hello' })).ok, true);
  assert.equal((await engine.call('mac_key', { key: 'cmd+s' })).ok, true);
  const log = fs.readFileSync(LOG, 'utf8');
  assert.match(log, /type hello/);
  assert.match(log, /press cmd\+s/);
});

await test('mac_apps and mac_windows return structured lists', async () => {
  const apps = await engine.call('mac_apps', {});
  assert.equal(apps.ok, true);
  assert.equal(apps.apps[0].name, 'Safari');
  const wins = await engine.call('mac_windows', {});
  assert.equal(wins.ok, true);
  assert.equal(wins.windows[0].id, 42);
});

await test('mac_windows enumerates the windows of the running apps', async () => {
  const r = await engine.call('mac_windows', {});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.windows[0].title, 'Documents');
  assert.equal(r.windows[0].app, 'Safari');
});

await test('mac_element finds controls by their visible name', async () => {
  const r = await engine.call('mac_element', { name: 'Save' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.count, 1);
  assert.equal(r.matches[0].id, 'B1');
  assert.equal(r.matches[0].role, 'button');
});

await test('mac_element can filter by role', async () => {
  const r = await engine.call('mac_element', { role: 'textField' });
  assert.equal(r.count, 1);
  assert.equal(r.matches[0].title, 'Search');
});

await test('mac_set writes a value through the accessibility API', async () => {
  const r = await engine.call('mac_set', { on: 'B2', value: 'hello' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(fs.readFileSync(LOG, 'utf8'), /set-value hello --on B2/);
});

await test('mac_menu lists and clicks menu items by name', async () => {
  const list = await engine.call('mac_menu', { app: 'Safari' });
  assert.equal(list.ok, true);
  assert.equal(list.menus[0].title, 'File');
  const click = await engine.call('mac_menu_click', { item: 'Save', app: 'Safari' });
  assert.equal(click.ok, true, JSON.stringify(click));
  assert.match(fs.readFileSync(LOG, 'utf8'), /menu click --item Save --app Safari/);
});

await test('mac_spaces shows the virtual desktops', async () => {
  const r = await engine.call('mac_spaces', {});
  assert.equal(r.ok, true);
  assert.equal(r.spaces[1].id, 2);
  assert.equal(r.spaces[0].is_active, true);
  const sw = await engine.call('mac_space_switch', { to: '2' });
  assert.equal(sw.ok, true, JSON.stringify(sw));
  assert.match(fs.readFileSync(LOG, 'utf8'), /space switch --to 2/);
});

await test('mac_wait reports the element it waited for', async () => {
  const r = await engine.call('mac_wait', { name: 'Save', timeout: 5 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.found, true);
  assert.equal(r.element.id, 'B1');
});

await test('mac_wait can wait for something to disappear', async () => {
  const r = await engine.call('mac_wait', { name: 'Nothing here', disappear: true, timeout: 5 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.gone, true);
});

await test('mac_permissions explains what macOS still asks for', async () => {
  const r = await engine.call('mac_permissions', {});
  assert.equal(r.ok, true);
  assert.match(r.permissions, /Screen Recording/);
});

await test('a missing peekaboo is reported instead of crashing', async () => {
  const saved = process.env.PEEKABOO_PATH;
  process.env.PEEKABOO_PATH = '/nonexistent/peekaboo';
  const cfg2 = { ...cfg, peekabooPath: '/nonexistent/peekaboo' };
  const engine2 = new Engine(cfg2, { base: WORK });
  const r = await engine2.call('mac_see', { path: path.join(WORK, 'x.png') });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'peekaboo_not_found');
  assert.match(r.hint, /peekaboo/);
  process.env.PEEKABOO_PATH = saved;
});

console.log('\n▸ approvals');

await test('a pending approval is reported clearly instead of hanging', async () => {
  saveConfig({ ...cfg, requireApproval: true, approvalWaitSec: 1 }); // the engine re-reads the policy per call
  const engine3 = new Engine(loadConfig(), { base: WORK });
  const r = await engine3.call('mac_click', { on: 'B1' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'APPROVAL_PENDING');
  assert.equal(r.pending, true);
  assert.ok(r.approval_id);
  assert.match(r.hint, /arena-bridge approve/);
  saveConfig(cfg);
});

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
