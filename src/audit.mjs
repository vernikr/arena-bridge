import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.mjs';

/** The config directory is resolved on every call so tests and relocations stay isolated. */
function configDir() {
  return process.env.ARENA_BRIDGE_HOME || CONFIG_DIR;
}

export function auditPath() {
  return path.join(configDir(), 'audit.log');
}

const SECRETS = [
  /(?<!\d)\d{6,12}:[A-Za-z0-9_-]{25,}/g, // telegram bot tokens
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // github tokens
  /\bnpm_[A-Za-z0-9]{20,}\b/g, // npm tokens
  /\bpypi-[A-Za-z0-9_-]{20,}\b/g, // pypi tokens
  /\bsk-[A-Za-z0-9]{20,}\b/g, // api keys
];

/** Mask anything that looks like a credential, so the log never becomes a secret store. */
export function scrub(value) {
  if (typeof value === 'string') {
    let out = value;
    for (const re of SECRETS) out = out.replace(re, '***');
    return out;
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v);
    return out;
  }
  return value;
}

export function audit(entry) {
  try {
    const dir = configDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const rec = { ts: new Date().toISOString(), ...scrub(entry) };
    fs.appendFileSync(auditPath(), JSON.stringify(rec) + '\n', { mode: 0o600 });
  } catch {
    /* auditing must never break the request */
  }
}

export function tailAudit(n = 50) {
  const file = auditPath();
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  return lines
    .slice(-n)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { raw: l };
      }
    });
}

/* ------------------------------------------------------------------ *
 * artifacts: screenshots, accessibility trees and other evidence
 * ------------------------------------------------------------------ */

export function auditDir() {
  return path.join(configDir(), 'audit');
}

export function saveArtifact(entryId, kind, name, data, meta = {}) {
  try {
    const dir = path.join(auditDir(), String(entryId));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, path.basename(String(name)));
    fs.writeFileSync(file, data, { mode: 0o600 });
    const bytes = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data));
    return { kind, name: path.basename(String(name)), path: file, bytes, ...meta };
  } catch {
    return null;
  }
}

export function readArtifact(entryId, name) {
  try {
    const base = path.resolve(auditDir());
    // entryId and name are treated as single path components (no slashes, no traversal)
    const target = path.resolve(path.join(base, path.basename(String(entryId)), path.basename(String(name))));
    // ensure target stays inside audit dir
    const rel = path.relative(base, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (!fs.existsSync(target)) return null;
    return { file: target, data: fs.readFileSync(target) };
  } catch {
    return null;
  }
}

export function listArtifacts() {
  const dir = auditDir();
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir)) {
    const sub = path.join(dir, entry);
    let files = [];
    try {
      files = fs
        .readdirSync(sub)
        .filter((f) => fs.statSync(path.join(sub, f)).isFile())
        .map((f) => ({ name: f, bytes: fs.statSync(path.join(sub, f)).size }));
    } catch {
      /* ignore */
    }
    if (files.length) out.push({ entry, files });
  }
  return out;
}

export function pruneArtifacts(days = 14) {
  const dir = auditDir();
  if (!fs.existsSync(dir)) return { removed: 0, freed_bytes: 0 };
  const cutoff = Date.now() - Number(days) * 86400000;
  let removed = 0;
  let freed = 0;
  for (const entry of fs.readdirSync(dir)) {
    const sub = path.join(dir, entry);
    try {
      const st = fs.statSync(sub);
      if (st.mtimeMs < cutoff) {
        freed += st.size;
        fs.rmSync(sub, { recursive: true, force: true });
        removed++;
      }
    } catch {
      /* ignore */
    }
  }
  return { removed, freed_bytes: freed };
}
