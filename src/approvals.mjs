import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { APPROVALS_DIR, ensureDirs } from './config.mjs';
import { sendTelegram, approvalKeyboard } from './telegram.mjs';
import { openTrust } from './trust.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
 * Settle a request and, when asked, open a trust window.
 * Blanket window (all tools, all agents) per user request: if trust is granted,
 * every tool for every agent is trusted until `until`.
 */
export function settle(id, decision, by = 'cli', { trustSec = 0 } = {}) {
  const res = decide(id, decision, by);
  if (res.ok && trustSec > 0) {
    openTrust({
      until: Date.now() + trustSec * 1000,
      tools: [], // blanket: all tools, any agent
      paths: [],
    }, { via: 'approval' });
  }
  return res;
}

function redact(args) {
  function scrub(v) {
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (/token|secret|password|authorization/i.test(k)) out[k] = '***';
        else out[k] = scrub(val);
      }
      return out;
    }
    return v;
  }
  const clone = scrub({ ...args });
  if (typeof clone.command === 'string' && clone.command.length > 4000) {
    clone.command = clone.command.slice(0, 4000) + '…';
  }
  return clone;
}

/**
 * Create a pending approval request and wait for a local human decision.
 * The request lives in a file so that the `arena-bridge approve` CLI (a separate
 * process) can pick it up.
 */
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

export async function requestApproval(tool, args, cfg) {
  ensureDirs();
  const id = crypto.randomUUID();
  const now = Date.now();
  const rec = {
    id,
    tool,
    args: redact(args),
    status: 'pending',
    createdAt: now,
    expiresAt: now + (cfg.approvalTtlSec ?? 900) * 1000,
    decidedAt: null,
    decidedBy: null,
  };
  // B8 atomic
  {
    const fp = fileOf(id); const tmp = fp + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, fp);
  }

  // tell the user about it right away, so a pending request is not a dead end
  if (cfg.telegram?.enabled && cfg.telegram?.botToken) {
    sendTelegram(cfg, {
      title: 'Approval needed',
      text:
        `Tool: ${tool}\n` +
        `id: ${id}\n` +
        `Use the buttons below, reply /approve ${id} or /deny ${id}, or run: arena-bridge approve ${id}`,
      buttons: approvalKeyboard(id),
    }).catch(() => {});
  }

  const waitSec = Math.min(cfg.approvalWaitSec ?? 90, cfg.approvalTtlSec ?? 900);
  const deadline = now + waitSec * 1000;
  while (Date.now() < deadline) {
    await sleep(400);
    let cur;
    try {
      cur = JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
    } catch {
      continue;
    }
    if (cur.status === 'approved') return { approved: true, rec: cur };
    if (cur.status !== 'pending') return { approved: false, rec: cur };
    if (cur.expiresAt && Date.now() >= cur.expiresAt) {
      return { approved: false, rec: expireIfNeeded(fileOf(id), cur) };
    }
  }
  const timedOut = expireIfNeeded(fileOf(id), JSON.parse(fs.readFileSync(fileOf(id), 'utf8')));
  if (timedOut.status === 'pending') {
    timedOut.status = 'timeout';
    timedOut.decidedAt = Date.now();
    timedOut.decidedBy = 'system';
    { const fp=fileOf(id); const tmp=fp+'.tmp'; fs.writeFileSync(tmp, JSON.stringify(timedOut, null, 2), {mode:0o600}); fs.renameSync(tmp, fp); }
  }
  return { approved: timedOut.status === 'approved', rec: timedOut };
}
