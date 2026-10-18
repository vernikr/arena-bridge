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

export function audit(entry) {
  try {
    const dir = configDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const rec = { ts: new Date().toISOString(), ...entry };
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
    const file = path.join(auditDir(), String(entryId), path.basename(String(name)));
    if (!fs.existsSync(file)) return null;
    return { file, data: fs.readFileSync(file) };
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
