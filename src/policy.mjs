import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from './config.mjs';

/** Resolve a user supplied path to an absolute path, following symlinks on the existing prefix. */
export function resolveTarget(p, base = process.cwd()) {
  const raw = expandHome(String(p ?? '').trim());
  if (!raw) throw new Error('path is required');
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base, raw);

  // walk up to the deepest existing ancestor and realpath it, so symlinks cannot escape the roots
  const tail = [];
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    tail.unshift(path.basename(probe));
    probe = parent;
  }
  let real = probe;
  try {
    real = fs.realpathSync(probe);
  } catch {
    /* ignore */
  }
  return path.join(real, ...tail);
}

/** Resolve a configured path the same way as a target, so symlinks never break the comparison. */
function resolveConfigured(p, base) {
  try {
    return resolveTarget(p, base);
  } catch {
    return path.resolve(String(p ?? ''));
  }
}

export function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Path policy: protected locations are always denied, everything else must live under an
 * authorized root. Returns { ok, abs } or { ok:false, error:'PROTECTED', reason, abs }.
 */
export function checkPath(p, cfg, base = process.cwd(), _opts = {}) {
  let abs;
  try {
    abs = resolveTarget(p, base);
  } catch (e) {
    return { ok: false, error: 'INVALID_PATH', reason: e.message };
  }
  for (const prot of (cfg.protected || []).map((r) => resolveConfigured(r, base))) {
    if (isInside(abs, prot)) {
      return {
        ok: false,
        abs,
        error: 'PROTECTED',
        reason: `path is inside a protected location (${prot})`,
      };
    }
  }
  const roots = (cfg.roots || []).map((r) => resolveConfigured(r, base));
  if (!roots.some((r) => isInside(abs, r))) {
    return {
      ok: false,
      abs,
      error: 'PROTECTED',
      reason: `path is outside the authorized roots (${roots.join(', ')})`,
    };
  }
  return { ok: true, abs };
}
