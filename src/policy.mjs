import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from './config.mjs';

/** Resolve a user supplied path to an absolute path, following symlinks on the existing prefix. */
export function resolveTarget(p, base = process.cwd()) {
  const raw = expandHome(String(p ?? '').trim());
  if (!raw) throw new Error('path is required');
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base, raw);

  // Resolve symlinks component-by-component, including dangling links (B1 fix)
  // Use lstat to detect symlinks even when target does not exist
  let cur = abs;
  const seen = new Set();
  for (let depth = 0; depth < 20; depth++) {
    // Find the deepest existing path component via lstat (not stat)
    let probe = cur;
    let tail = [];
    while (true) {
      try {
        const st = fs.lstatSync(probe);
        // if probe itself is a symlink, resolve it
        if (st.isSymbolicLink()) {
          const link = fs.readlinkSync(probe);
          const dir = path.dirname(probe);
          const next = path.resolve(dir, link);
          const rest = cur.slice(probe.length);
          if (seen.has(next + rest)) break;
          seen.add(next + rest);
          cur = next + rest;
          probe = cur;
          tail = [];
          continue;
        }
        break;
      } catch {
        // probe does not exist as lstat, walk up
        const parent = path.dirname(probe);
        if (parent === probe) break;
        tail.unshift(path.basename(probe));
        probe = parent;
      }
    }
    // Now probe exists (or is root), realpath it
    let real = probe;
    try {
      real = fs.realpathSync(probe);
    } catch {}
    cur = path.join(real, ...tail);
    // If no more symlinks were found, we're done
    if (tail.length === 0) {
      // check if cur itself is symlink that we haven't yet resolved (dangling)
      try {
        const st2 = fs.lstatSync(cur);
        if (st2.isSymbolicLink()) continue;
      } catch {}
      break;
    }
    // otherwise, we resolved parent, but tail may contain symlink - loop again
    // to detect symlink inside tail
    // Check tail components for symlink
    let hasSymlinkInTail = false;
    let checkPath = real;
    for (const part of tail) {
      checkPath = path.join(checkPath, part);
      try {
        const st = fs.lstatSync(checkPath);
        if (st.isSymbolicLink()) { hasSymlinkInTail = true; break; }
      } catch {}
    }
    if (!hasSymlinkInTail) break;
  }
  return cur;
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
