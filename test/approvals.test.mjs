import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-approvals-'));
const previousHome = process.env.ARENA_BRIDGE_HOME;
process.env.ARENA_BRIDGE_HOME = home;
after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.ARENA_BRIDGE_HOME;
  else process.env.ARENA_BRIDGE_HOME = previousHome;
});

const { CONFIG_DIR, APPROVALS_DIR, ensureDirs } = await import('../src/config.mjs');
const { requestApproval, listApprovals, decide, settle } = await import('../src/approvals.mjs');
const { TRUST_PATH } = await import('../src/trust.mjs');
assert.equal(CONFIG_DIR, home);
assert.equal(APPROVALS_DIR, path.join(home, 'approvals'));
assert.equal(TRUST_PATH, path.join(home, 'trust.json'));
ensureDirs();

const read = (id) => JSON.parse(fs.readFileSync(path.join(APPROVALS_DIR, `${id}.json`), 'utf8'));
function seed(id, expired = true) {
  const now = Date.now();
  const rec = { id, tool: 'shell', args: {}, status: 'pending', createdAt: now - 2000,
    expiresAt: now + (expired ? -1000 : 900000), decidedAt: null, decidedBy: null };
  fs.writeFileSync(path.join(APPROVALS_DIR, `${id}.json`), JSON.stringify(rec));
  return rec;
}
function systemDecision(rec, status) {
  assert.equal(rec.status, status);
  assert.equal(rec.decidedBy, 'system');
  assert.ok(Number.isInteger(rec.decidedAt) && rec.decidedAt >= rec.createdAt);
}

test('wait=0 with TTL=900 persists timeout', async () => {
  const result = await requestApproval('shell', {}, { approvalWaitSec: 0, approvalTtlSec: 900 });
  assert.equal(result.approved, false);
  systemDecision(result.rec, 'timeout');
  assert.equal(result.rec.expiresAt - result.rec.createdAt, 900000);
  assert.deepEqual(read(result.rec.id), result.rec);
});

test('TTL=0 returns and persists expired', async () => {
  const result = await requestApproval('shell', {}, { approvalWaitSec: 0, approvalTtlSec: 0 });
  assert.equal(result.approved, false);
  assert.deepEqual(read(result.rec.id), result.rec);
  systemDecision(result.rec, 'expired');
});

test('list lazily persists expiry of pending records', () => {
  seed('list-expired');
  const rec = listApprovals().find((item) => item.id === 'list-expired');
  systemDecision(rec, 'expired');
  assert.deepEqual(read(rec.id), rec);
});

test('decide rejects expired pending without listing first', () => {
  seed('decide-expired');
  assert.deepEqual(decide('decide-expired', 'approve'), { ok: false, error: 'already expired' });
  systemDecision(read('decide-expired'), 'expired');
});

test('settle rejects expired pending and does not create trust', () => {
  seed('settle-expired');
  assert.equal(fs.existsSync(TRUST_PATH), false);
  assert.deepEqual(settle('settle-expired', 'approve', 'test', { trustSec: 900 }),
    { ok: false, error: 'already expired' });
  systemDecision(read('settle-expired'), 'expired');
  assert.equal(fs.existsSync(TRUST_PATH), false);
});

for (const [decision, status] of [['approve', 'approved'], ['deny', 'denied']]) {
  test(`live ${decision} persists the decision`, () => {
    const id = `live-${decision}`;
    seed(id, false);
    const result = decide(id, decision, 'test');
    assert.equal(result.ok, true);
    assert.equal(result.approval.status, status);
    assert.equal(result.approval.decidedBy, 'test');
    assert.ok(Number.isInteger(result.approval.decidedAt));
    assert.deepEqual(read(id), result.approval);
  });
}
