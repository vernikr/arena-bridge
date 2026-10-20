/**
 * Work log recording: full parameters, masking, alert levels, caller source,
 * rejected and unauthorized requests, agent notes. Run with: node --test test/log.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-log-'));
const HOME = path.join(TMP, 'home');
const WORK = path.join(TMP, 'work');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });
process.env.ARENA_BRIDGE_HOME = HOME;
fs.writeFileSync(path.join(WORK, 'hello.txt'), 'hello\n');

const { DEFAULTS, saveConfig, loadConfig } = await import('../src/config.mjs');
const { Engine } = await import('../src/engine.mjs');
const { createDirectServer } = await import('../src/direct.mjs');
const { audit, tailAudit, readArtifact, levelFor, scrub } = await import('../src/audit.mjs');
const { describeSource, admitUnauthorized } = await import('../src/source.mjs');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const cfg = {
  ...DEFAULTS,
  mode: 'direct',
  host: '127.0.0.1',
  port: 0,
  token: 'log-test-agent-token',
  localToken: 'log-test-local-token',
  device: 'logbox',
  roots: [WORK],
  protected: [],
  requireApproval: false,
  approvalWaitSec: 5,
  publicUrl: 'https://example.test',
};
saveConfig(cfg);
const loaded = loadConfig();
const engine = new Engine(loaded, { base: WORK });
const server = createDirectServer(loaded, engine);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => new Promise((r) => server.close(r)));
const base = `http://127.0.0.1:${server.address().port}`;
const auth = { Authorization: `Bearer ${loaded.token}`, 'Content-Type': 'application/json' };
const lastFor = (pred) => tailAudit(500).filter(pred).at(-1);

test('parameters are stored whole; overflow goes to an artifact and is recoverable', () => {
  const content = 'a'.repeat(200_000);
  audit({ id: 'log-test-overflow', tool: 'write_file', args: { path: '/x', content }, status: 'ok' });
  const rec = tailAudit(1)[0];
  assert.equal(rec.id, 'log-test-overflow');
  assert.equal(rec.args_truncated, true);
  assert.equal(rec.args_artifact, 'args.json');
  const art = readArtifact('log-test-overflow', 'args.json');
  assert.equal(JSON.parse(art.data.toString('utf8')).content.length, content.length);
});

test('a 5 000 character parameter stays inline and whole', () => {
  const text = 'b'.repeat(5000);
  audit({ id: 'log-test-inline', tool: 'log_note', args: { text } });
  const rec = tailAudit(1)[0];
  assert.equal(rec.args.text.length, 5000);
  assert.equal(rec.args_truncated, false);
  assert.equal(rec.args_artifact, undefined);
});

test('credentials are masked in parameters, environment values and secret-named keys', () => {
  const out = scrub({
    command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuv" && echo AKIAABCDEFGHIJKLMNOP',
    env: { HOME: '/Users/x', DB_PASSWORD: 'hunter2' },
    access_token: 'plain-value',
    key: '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----',
  });
  assert.doesNotMatch(out.command, /abcdefghijklmnop|AKIAABCDEFGHIJKLMNOP/);
  assert.equal(out.env.HOME, '***');
  assert.equal(out.env.DB_PASSWORD, '***');
  assert.equal(out.access_token, '***');
  assert.doesNotMatch(out.key, /MIIBOgIBAAJBAK/);
});

test('alert levels follow the kind and the outcome', () => {
  assert.equal(levelFor({ kind: 'call', status: 'ok' }), 'info');
  assert.equal(levelFor({ kind: 'call', status: 'approval_denied' }), 'warning');
  assert.equal(levelFor({ kind: 'call', status: 'rejected' }), 'warning');
  assert.equal(levelFor({ kind: 'call', status: 'exception' }), 'warning');
  assert.equal(levelFor({ kind: 'note', status: 'ok' }), 'info');
  assert.equal(levelFor({ kind: 'note', status: 'error' }), 'warning');
  assert.equal(levelFor({ kind: 'auth', status: 'unauthorized' }), 'alert');
  assert.equal(levelFor({ kind: 'approval', status: 'forbidden' }), 'alert');
  assert.equal(levelFor({ kind: 'trust', status: 'opened' }), 'notice');
  assert.equal(levelFor({ kind: 'call', status: 'ok', level: 'alert' }), 'alert');
});

test('an unknown tool is recorded as rejected, with its source', async () => {
  const source = { channel: 'http', ip: '203.0.113.7', country: 'US', host: null, client: 'probe' };
  const res = await engine.call('no_such_tool', { a: 1 }, { source });
  assert.equal(res.error, 'UNKNOWN_TOOL');
  const rec = lastFor((r) => r.tool === 'no_such_tool');
  assert.equal(rec.status, 'rejected');
  assert.equal(rec.level, 'warning');
  assert.deepEqual(rec.source, source);
  assert.equal(rec.args.a, 1);
});

test('the agent note is an info entry; a second note within a second is refused and logged', async () => {
  const first = await engine.call('log_note', { text: '  Next: check the build.  ' }, { source: { channel: 'mcp' } });
  assert.equal(first.ok, true);
  const noteRec = lastFor((r) => r.tool === 'log_note');
  assert.equal(noteRec.kind, 'note');
  assert.equal(noteRec.level, 'info');
  assert.equal(noteRec.source.channel, 'mcp');

  const second = await engine.call('log_note', { text: 'too soon' }, { source: { channel: 'mcp' } });
  assert.equal(second.error, 'RATE_LIMITED');
  const limited = lastFor((r) => r.tool === 'log_note' && r.status === 'error');
  assert.equal(limited.level, 'warning');
});

test('a note longer than 500 characters is refused', async () => {
  await new Promise((r) => setTimeout(r, 1050));
  const res = await engine.call('log_note', { text: 'x'.repeat(501) });
  assert.equal(res.error, 'INVALID_ARGS');
});

test('the caller is described by the tunnel address, not by a forwarded header', () => {
  const req = (headers, remote = '127.0.0.1') => ({ headers, socket: { remoteAddress: remote } });
  const s1 = describeSource(
    req({ 'cf-connecting-ip': '198.51.100.9', 'x-forwarded-for': '1.2.3.4', 'cf-ipcountry': 'NL', 'user-agent': 'agent/1.0\u0007' }),
    'http',
  );
  assert.equal(s1.ip, '198.51.100.9');
  assert.equal(s1.country, 'NL');
  assert.equal(s1.client, 'agent/1.0');
  const s2 = describeSource(req({ 'cf-connecting-ip': 'not-an-ip' }, '::ffff:192.0.2.1'), 'http');
  assert.equal(s2.ip, '192.0.2.1');
  assert.equal(s2.client, null);
});

test('failed authentications are logged at the start of each minute and counted after it', () => {
  const t0 = 1_000_000;
  const seen = [];
  for (let i = 0; i < 7; i++) seen.push(admitUnauthorized('198.51.100.50', t0 + i));
  assert.deepEqual(seen.map((s) => s.write), [true, true, true, true, true, false, false]);
  const next = admitUnauthorized('198.51.100.50', t0 + 61_000);
  assert.equal(next.previousSuppressed, 2);
  assert.equal(next.write, true);
});

test('over HTTP: unauthorized, unknown tool, invalid JSON and file reads are all recorded', async () => {
  const bad = await fetch(`${base}/call`, {
    method: 'POST',
    headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'bash', args: { command: 'id' } }),
  });
  assert.equal(bad.status, 401);
  const alert = lastFor((r) => r.kind === 'auth');
  assert.equal(alert.level, 'alert');
  assert.equal(alert.status, 'unauthorized');
  assert.equal(alert.source.ip, '127.0.0.1');

  const unknown = await fetch(`${base}/call`, { method: 'POST', headers: auth, body: JSON.stringify({ tool: 'nope' }) });
  assert.equal(unknown.status, 400);
  const rejected = lastFor((r) => r.tool === 'nope');
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.source.channel, 'http');

  const broken = await fetch(`${base}/call`, { method: 'POST', headers: auth, body: '{not json' });
  assert.equal(broken.status, 400);
  assert.equal((await broken.json()).error, 'INVALID_JSON');
  assert.equal(lastFor((r) => r.error === 'INVALID_JSON').level, 'warning');

  const read = await fetch(`${base}/files?path=${encodeURIComponent(path.join(WORK, 'hello.txt'))}`, { headers: auth });
  assert.equal(read.status, 200);
  const fileRec = lastFor((r) => r.tool === 'file_get');
  assert.equal(fileRec.via, 'files_api');
  assert.equal(fileRec.status, 'ok');

  const outside = await fetch(`${base}/files?path=${encodeURIComponent('/etc/hosts')}`, { headers: auth });
  assert.equal(outside.status, 200, 'non-protected paths are not blocked by legacy roots');
  const outsideRec = lastFor((r) => r.tool === 'file_get');
  assert.equal(outsideRec.status, 'ok');
});

test('over HTTP: an agent note sent through MCP is recorded with the MCP channel', async () => {
  await new Promise((r) => setTimeout(r, 1050));
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...auth, 'User-Agent': 'mcp-client/2.0' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'log_note', arguments: { text: 'Starting the test run.' } },
    }),
  });
  assert.equal(r.status, 200);
  const rec = lastFor((x) => x.kind === 'note' && x.args?.text === 'Starting the test run.');
  assert.equal(rec.source.channel, 'mcp');
  assert.equal(rec.source.client, 'mcp-client/2.0');
});

test('a recorded call carries every field of the record contract', async () => {
  const res = await engine.call('list_dir', { path: '.' }, { source: { channel: 'http', ip: '203.0.113.7', country: 'PL', host: null, client: 'contract' } });
  assert.equal(res.ok, true);
  const rec = lastFor((r) => r.tool === 'list_dir');
  for (const key of ['id', 'ts', 'level', 'kind', 'tool', 'status', 'duration_ms', 'via', 'actor', 'source', 'args', 'args_truncated']) {
    assert.ok(key in rec, `missing ${key}`);
  }
  assert.equal(rec.kind, 'call');
  assert.equal(rec.via, 'direct');
  assert.equal(rec.actor, 'agent');
  assert.equal(rec.level, 'info');
  assert.equal(rec.source.country, 'PL');
  assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
