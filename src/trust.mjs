import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, ensureDirs } from './config.mjs';
import { isInside, resolveTarget } from './policy.mjs';

export const TRUST_PATH = path.join(CONFIG_DIR, 'trust.json');

/** Parse "30m" | "2h" | "1d" | "90" (minutes) into milliseconds. */
export function parseDuration(value) {
  if (value === undefined || value === null || value === true) return 60 * 60 * 1000; // default 1h
  const raw = String(value).trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/.exec(raw);
  if (!m) throw new Error(`cannot parse duration: ${value}`);
  const n = parseFloat(m[1]);
  const unit = m[2] || 'm';
  const factor = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return Math.round(n * factor);
}

export function loadTrust() {
  if (!fs.existsSync(TRUST_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(TRUST_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export function saveTrust(state) {
  ensureDirs();
  fs.writeFileSync(TRUST_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
  return state;
}

export function clearTrust() {
  if (fs.existsSync(TRUST_PATH)) fs.rmSync(TRUST_PATH);
}

/** Normalised view of the trust window: { active, until, tools, paths, expired }. */
export function pruneExpiredTrust() {
  try {
    const cur = trustState();
    if (cur && cur.until && Date.now() > cur.until && cur.active) {
      clearTrust();
      return true;
    }
  } catch {}
  return false;
}
export function trustState() {
  const t = loadTrust();
  if (!t) return { active: false, until: null, tools: [], paths: [] };
  const expired = !t.until || t.until <= Date.now();
  return {
    active: !expired && t.enabled !== false,
    expired,
    until: t.until || null,
    tools: t.tools || [],
    paths: t.paths || [],
    createdAt: t.createdAt || null,
  };
}

/**
 * Does the active trust window cover this call?
 *  - an explicit tool list means "trust these fully"
 *  - otherwise the (optional) path list restricts which paths may be touched;
 *    commands without a target path (bash) are only trusted if listed explicitly.
 */
export function trustAllows(state, toolName, args = {}, cfg = {}) {
  if (!state?.active) return false;
  const tools = state.tools || [];
  const paths = (state.paths || []).map((p) => {
    try {
      return resolveTarget(p, process.cwd());
    } catch {
      return null;
    }
  }).filter(Boolean);

  if (tools.length) return tools.includes(toolName);

  if (paths.length) {
    const target = args?.path ?? args?.file_path;
    if (!target) return false;
    try {
      const abs = resolveTarget(target, cfg?.base || process.cwd());
      return paths.some((p) => isInside(abs, p));
    } catch {
      return false;
    }
  }
  return true;
}
