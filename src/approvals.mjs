import fs from 'node:fs';
import path from 'node:path';
import { APPROVALS_DIR } from './config.mjs';

function fileOf(id) {
  return path.join(APPROVALS_DIR, `${id}.json`);
}

function expireIfNeeded(file, rec, now = Date.now()) {
  if (rec.status === 'pending' && rec.expiresAt && now >= rec.expiresAt) {
    rec.status = 'expired';
    rec.decidedAt = now;
    rec.decidedBy = 'system';
    fs.writeFileSync(file, JSON.stringify(rec, null, 2), { mode: 0o600 });
  }
  return rec;
}

export function listApprovals() {
  if (!fs.existsSync(APPROVALS_DIR)) return [];
  return fs
    .readdirSync(APPROVALS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const file = path.join(APPROVALS_DIR, f);
        return expireIfNeeded(file, JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function decide(id, decision, by = 'cli') {
  const file = fileOf(id);
  if (!fs.existsSync(file)) return { ok: false, error: `unknown approval id: ${id}` };
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, error: e.message };
  }
  rec = expireIfNeeded(file, rec);
  if (rec.status !== 'pending') return { ok: false, error: `already ${rec.status}` };
  rec.status = decision === 'approve' ? 'approved' : 'denied';
  rec.decidedAt = Date.now();
  rec.decidedBy = by;
  fs.writeFileSync(file, JSON.stringify(rec, null, 2), { mode: 0o600 });
  return { ok: true, approval: rec };
}

/**
 * Settle a historical request. Kept for backwards compatibility;
 * trustSec is ignored (there is no trust window).
 */
export function settle(id, decision, by = 'cli', { trustSec = 0 } = {}) {
  return decide(id, decision, by);
}

export function pruneApprovals(days = 14) {
  if (!fs.existsSync(APPROVALS_DIR)) return { removed: 0 };
  const cutoff = Date.now() - days * 86400000;
  let removed = 0;
  for (const f of fs.readdirSync(APPROVALS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(APPROVALS_DIR, f);
    try {
      const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
      const ts = rec.decidedAt || rec.createdAt || 0;
      if (rec.status !== 'pending' && ts && ts < cutoff) {
        fs.unlinkSync(file);
        removed++;
      }
    } catch {}
  }
  return { removed };
}
