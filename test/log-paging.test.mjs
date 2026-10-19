/**
 * Work log lifecycle and paging: trust and service events, cursor paging over 100 000 records,
 * rotation and retention, HTTP routes. Run with: node --test test/log-paging.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-paging-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });
process.env.ARENA_BRIDGE_HOME = HOME;
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { saveConfig, loadConfig, DEFAULTS } = await import('../src/config.mjs');
const { Engine } = await import('../src/engine.mjs');
const { createDirectServer } = await import('../src/direct.mjs');
const { openTrust, closeTrust, reconcileTrust, TRUST_PATH } = await import('../src/trust.mjs');
const { bridgeEvent, tunnelEvent } = await import('../src/lifecycle.mjs');
const {
  audit, auditPage, auditPath, segments, startCursor, headCursor, tailAudit, findEntry, lean, rotateAudit, pruneAudit,
} = await import('../src/audit.mjs');

const trustEvents = () => tailAudit(10_000).filter((e) => e.kind === 'trust').map((e) => `${e.status}:${e.via}`);

test('trust window: open, extend, close, expire and external change each log exactly one event', () => {
  const now = Date.now();
  openTrust({ until: now + 3_600_000, tools: [], paths: [] }, { via: 'launch', source: { channel: 'local' } });
  openTrust({ until: now + 7_200_000, tools: [], paths: [] }, { via: 'cli' });
  closeTrust({ via: 'cli' });
  openTrust({ until: now + 60_000, tools: [], paths: [] }, { via: 'approval' });
  assert.equal(reconcileTrust(now + 3_600_000), true);
  assert.equal(reconcileTrust(now + 3_600_000), false);
  fs.writeFileSync(TRUST_PATH, JSON.stringify({ enabled: true, until: now + 3_600_000, tools: [], paths: [] }));
  reconcileTrust();
  reconcileTrust();
  fs.rmSync(TRUST_PATH);
  reconcileTrust();
  assert.deepEqual(trustEvents(), [
    'open:launch', 'extend:cli', 'close:cli', 'open:approval', 'expire:expiry', 'open:external', 'close:external',
  ]);
});

test('bridge and tunnel lifecycle events are recorded with their origin', () => {
  bridgeEvent('start', { port: 8787 });
  tunnelEvent('up', { url: 'example.trycloudflare.com' });
  tunnelEvent('down', { code: 1 });
  bridgeEvent('stop', { reason: 'signal' });
  const seen = tailAudit(4).map((e) => `${e.kind}:${e.status}:${e.via}`);
  assert.deepEqual(seen, ['service:start:cli', 'tunnel:up:cli', 'tunnel:down:cli', 'service:stop:cli']);
});

/* ---- 100 000 synthetic records across nine archives and the active file ---- */

const BASE_MS = 1_700_000_000_000;
const PER_FILE = 10_000;
const FILES = 10;
const TOTAL = PER_FILE * FILES;

function line(i) {
  return JSON.stringify({
    id: `s${i}`,
    ts: new Date(BASE_MS + i * 1000).toISOString(),
    kind: 'synthetic',
    tool: i % 2 ? 'bash' : 'read_file',
    status: 'ok',
    level: i % 50 === 0 ? 'alert' : i % 5 === 0 ? 'warning' : 'info',
    actor: 'agent',
    source: null,
    args: { i, text: 'x'.repeat(100) },
    args_truncated: false,
  });
}

function fill() {
  for (let f = 0; f < FILES; f++) {
    const lines = [];
    for (let k = 0; k < PER_FILE; k++) lines.push(line(f * PER_FILE + k));
    const body = lines.join('\n') + '\n';
    if (f < FILES - 1) {
      fs.writeFileSync(path.join(HOME, `audit-${String(BASE_MS + f * 1000).padStart(13, '0')}.log`), body);
    } else {
      fs.appendFileSync(auditPath(), body);
    }
  }
}
fill();

function collect(params) {
  const pages = [];
  let before;
  do {
    const page = auditPage({ limit: 500, before, ...params });
    pages.unshift(page.entries);
    before = page.next || undefined;
    if (!page.has_more) break;
  } while (before);
  return pages.flat();
}

test('cursor paging backwards over 100 000 records: no duplicates, no gaps, filters applied', () => {
  const all = collect({ kind: 'synthetic' });
  assert.equal(all.length, TOTAL);
  assert.equal(new Set(all.map((e) => e.id)).size, TOTAL);
  all.forEach((e, idx) => assert.equal(e.id, `s${idx}`));
  const warnings = collect({ kind: 'synthetic', level: 'warning' });
  assert.equal(warnings.length, TOTAL / 5);
  assert.ok(warnings.every((e) => ['warning', 'alert'].includes(e.level)));
});

test('cursor paging forwards from the start: no duplicates, no gaps', () => {
  const got = [];
  let after = startCursor();
  for (;;) {
    const page = auditPage({ after, limit: 500, kind: 'synthetic' });
    got.push(...page.entries);
    after = page.next;
    if (!page.entries.length && !page.has_more) break;
  }
  assert.equal(got.length, TOTAL);
  got.forEach((e, idx) => assert.equal(e.id, `s${idx}`));
});

test('a 500-record page from a 100 000-record log returns in under 100 ms (median)', () => {
  const samples = [];
  for (let n = 0; n < 25; n++) {
    const t0 = process.hrtime.bigint();
    const page = auditPage({ limit: 500 });
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    assert.equal(page.entries.length, 500);
  }
  samples.sort((a, b) => a - b);
  const median = samples[samples.length >> 1];
  console.log(`page of 500 from a ${TOTAL}-record log: median ${median.toFixed(2)} ms`);
  assert.ok(median < 100, `median ${median} ms`);
});

test('HTTP: /audit pages with cursors, /audit/entry returns the full record, /log/event accepts only steps', async () => {
  const cfg = {
    ...DEFAULTS, mode: 'direct', host: '127.0.0.1', port: 0,
    token: 'paging-agent-token', localToken: 'paging-local-token', device: 'pagingbox',
    roots: [TMP], protected: [], requireApproval: false, approvalWaitSec: 5, publicUrl: 'https://example.test',
  };
  saveConfig(cfg);
  const loaded = loadConfig();
  const server = createDirectServer(loaded, new Engine(loaded, { base: TMP }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = { Authorization: `Bearer ${loaded.token}`, 'Content-Type': 'application/json' };
  const step = (message, status = '2') => fetch(`${base}/log/event`, {
    method: 'POST', headers: h, body: JSON.stringify({ kind: 'step', tool: 'start-bridge', status, level: 'notice', message }),
  });

  assert.equal((await fetch(`${base}/log/event`, { method: 'POST', headers: h, body: JSON.stringify({ kind: 'trust', status: 'open', message: 'x' }) })).status, 400);
  assert.equal((await fetch(`${base}/log/event`, { method: 'POST', headers: h, body: JSON.stringify({ kind: 'step', status: '1', message: 'a'.repeat(501) }) })).status, 400);
  assert.equal((await step('Step 2 of 5: service loaded')).status, 200);
  assert.equal((await fetch(`${base}/audit?before=%%%`, { headers: h })).status, 400);

  const first = await (await fetch(`${base}/audit?limit=3`, { headers: h })).json();
  assert.equal(first.entries.at(-1).message, 'Step 2 of 5: service loaded');
  assert.ok(first.head);
  const full = await (await fetch(`${base}/audit/entry?id=${encodeURIComponent(first.entries.at(-1).id)}`, { headers: h })).json();
  assert.equal(full.entry.message, 'Step 2 of 5: service loaded');
  assert.equal(full.entry.args_preview, undefined);
  assert.equal((await fetch(`${base}/audit/entry?id=nope`, { headers: h })).status, 404);

  await step('Step 3 of 5: listening');
  const delta = await (await fetch(`${base}/audit?after=${encodeURIComponent(first.head)}`, { headers: h })).json();
  assert.deepEqual(delta.entries.map((e) => e.message), ['Step 3 of 5: listening']);
  assert.equal(lean(delta.entries[0]).args, undefined);
  assert.equal((await fetch(`${base}/audit`)).status, 401);
});

test('rotation closes the active file; a cursor taken before it still reads forward', () => {
  audit({ kind: 'step', tool: 'rot', status: '1', level: 'info', message: 'before rotation' });
  const head = headCursor();
  const name = rotateAudit();
  audit({ kind: 'step', tool: 'rot', status: '1', level: 'info', message: 'after rotation' });
  assert.ok(name && fs.existsSync(path.join(HOME, name)));
  assert.deepEqual(auditPage({ after: head }).entries.map((e) => e.message), ['after rotation']);
  assert.equal(findEntry('no-such-id'), null);
});

test('retention keeps the newest archive intact and removes older ones', () => {
  const names = segments();
  const archives = names.slice(0, -1);
  const newest = archives.at(-1);
  const sizeBefore = fs.statSync(path.join(HOME, newest)).size;
  const res = pruneAudit({ maxBytes: 1, days: 0, now: Date.now() + 1000 });
  assert.equal(res.removed, archives.length - 1);
  assert.equal(fs.statSync(path.join(HOME, newest)).size, sizeBefore);
  assert.ok(fs.existsSync(auditPath()));
  assert.equal(segments().length, 2);
});
