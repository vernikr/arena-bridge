import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { APPROVALS_DIR, ensureDirs } from './config.mjs';
import { sendTelegram, approvalKeyboard } from './telegram.mjs';
import { saveTrust } from './trust.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fileOf(id) {
  return path.join(APPROVALS_DIR, `${id}.json`);
}

export function listApprovals() {
  if (!fs.existsSync(APPROVALS_DIR)) return [];
  return fs
    .readdirSync(APPROVALS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(APPROVALS_DIR, f), 'utf8'));
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
  if (rec.status !== 'pending') return { ok: false, error: `already ${rec.status}` };
  rec.status = decision === 'approve' ? 'approved' : 'denied';
  rec.decidedAt = Date.now();
  rec.decidedBy = by;
  fs.writeFileSync(file, JSON.stringify(rec, null, 2), { mode: 0o600 });
  return { ok: true, approval: rec };
}

/**
 * Settle a request and, when asked, open a trust window for the same tool.
 */
export function settle(id, decision, by = 'cli', { trustSec = 0 } = {}) {
  const res = decide(id, decision, by);
  if (res.ok && trustSec > 0) {
    const tool = res.approval?.tool;
    saveTrust({
      enabled: true,
      until: Date.now() + trustSec * 1000,
      tools: tool ? [tool] : [],
      paths: [],
      createdAt: Date.now(),
    });
  }
  return res;
}

function redact(args) {
  const clone = { ...args };
  for (const k of Object.keys(clone)) {
    if (/token|secret|password|key/i.test(k)) clone[k] = '***';
  }
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
  fs.writeFileSync(fileOf(id), JSON.stringify(rec, null, 2), { mode: 0o600 });

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
    if (cur.status === 'denied') return { approved: false, rec: cur };
    if (cur.expiresAt && Date.now() > cur.expiresAt) {
      return { approved: false, rec: { ...cur, status: 'expired' } };
    }
  }
  return { approved: false, rec: { ...rec, status: 'timeout' } };
}
