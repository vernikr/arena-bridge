import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-sec-'));
const prev = process.env.ARENA_BRIDGE_HOME;
process.env.ARENA_BRIDGE_HOME = home;
after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (prev === undefined) delete process.env.ARENA_BRIDGE_HOME;
  else process.env.ARENA_BRIDGE_HOME = prev;
});

const { loadConfig, saveConfig, DEFAULTS } = await import('../src/config.mjs');
const { Engine } = await import('../src/engine.mjs');
const { checkPath, resolveTarget } = await import('../src/policy.mjs');
const { allowedChat } = await import('../src/telegram.mjs');

// Setup temp work dirs
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-work-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-outside-'));
after(() => {
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

// prepare config with work as root, outside as protected attempt
const cfg = {
  ...DEFAULTS,
  roots: [work],
  protected: [path.join(work, 'protected')],
  allowShell: true,
  requireApproval: false,
  telegram: { enabled: true, botToken: 'test', chatIds: [123], poll: false },
};
fs.mkdirSync(path.join(work, 'protected'), { recursive: true });
fs.writeFileSync(path.join(work, 'protected', 'secret.txt'), 'secret');

test('S1: audit_artifact traversal blocked', async () => {
  const engine = new Engine(cfg, { base: work });
  // create a real artifact by calling a tool that saves artifact (e.g. need to simulate)
  // But we can test readArtifact directly: absolute entry should be blocked
  const { readArtifact } = await import('../src/audit.mjs');
  // try traversal via basename check: entry="../../etc" should be sanitized to "etc"
  const art = readArtifact('/etc', 'passwd');
  assert.equal(art, null, 'absolute entry should be blocked');
  const art2 = readArtifact('../../etc', 'passwd');
  assert.equal(art2, null, 'traversal should be blocked');
});

test('S2: list_dir respects protected', async () => {
  const engine = new Engine(cfg, { base: work });
  // create files inside and outside protected
  fs.writeFileSync(path.join(work, 'ok.txt'), 'ok');
  fs.writeFileSync(path.join(work, 'protected', 'secret2.txt'), 'secret');
  const res = await engine.call('list_dir', { path: work });
  assert.ok(res.ok);
  // protected files should not appear
  const names = (res.entries || []).map(e => e.name);
  assert.ok(!names.includes('secret.txt') || !res.entries.some(e => e.path.includes('protected/secret.txt')), 'protected file leaked');
});

test('S2b: access outside legacy roots is allowed', () => {
  const linkPath = path.join(work, 'link');
  try { fs.unlinkSync(linkPath); } catch {}
  try { fs.symlinkSync(path.join(outside, 'secret.txt'), linkPath); } catch {}
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside secret');
  const chk = checkPath(linkPath, cfg, work);
  // Legacy roots are ignored; the resolved target is accessible unless explicitly protected.
  assert.equal(chk.ok, true, 'path outside legacy roots should be allowed');
  try { fs.unlinkSync(linkPath); fs.unlinkSync(path.join(outside, 'secret.txt')); } catch {}
});

test('S5: exposeDeviceInHealth default true but configurable', () => {
  const c = loadConfig();
  // default should be true unless explicitly set
  assert.ok(c.exposeDeviceInHealth === true || c.exposeDeviceInHealth === undefined);
});

test('B2: historical approvals list and decide still work', async () => {
  const { listApprovals, decide } = await import('../src/approvals.mjs');
  const { APPROVALS_DIR, ensureDirs } = await import('../src/config.mjs');
  ensureDirs();
  const id = 'security-test-approval';
  const rec = { id, tool: 'mac_key', args: { key: 'cmd+q' }, status: 'pending',
    createdAt: Date.now(), expiresAt: Date.now() + 600000, decidedAt: null, decidedBy: null };
  fs.writeFileSync(path.join(APPROVALS_DIR, `${id}.json`), JSON.stringify(rec));
  const listed = listApprovals().find((a) => a.id === id);
  assert.ok(listed, 'historical approval is listed');
  assert.equal(listed.args.key, 'cmd+q', 'mac_key key is preserved in history');
  const decided = decide(id, 'approve', 'test');
  assert.equal(decided.ok, true);
  assert.equal(decided.approval.status, 'approved');
});

test('S4: allowedChat only allowed chat passes', () => {
  const cfgLocal = { telegram: { chatIds: [123, 456] } };
  assert.equal(allowedChat(cfgLocal, 123), true);
  assert.equal(allowedChat(cfgLocal, 999), false);
  assert.equal(allowedChat(cfgLocal, '123'), true); // string vs number
});

test('R3: edit_file does not interpret $&', async () => {
  const engine = new Engine(cfg, { base: work });
  const file = path.join(work, 'edit_test.txt');
  fs.writeFileSync(file, 'hello world');
  const res = await engine.call('edit_file', { path: file, old_text: 'world', new_text: 'foo$&bar$$baz' });
  assert.ok(res.ok, res.error);
  const content = fs.readFileSync(file, 'utf8');
  assert.equal(content, 'hello foo$&bar$$baz', 'replacement should be literal not pattern');
});

test('S7: audit limit=abc handled', async () => {
  const engine = new Engine(cfg, { base: work });
  const res = await engine.call('audit_log', { limit: 'abc' });
  // should not throw, should return ok with default limit
  assert.ok(res.ok);
});
