import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG_DIR } from './config.mjs';

/** The config directory is resolved on every call so tests and relocations stay isolated. */
function configDir() {
  return process.env.ARENA_BRIDGE_HOME || CONFIG_DIR;
}

export function auditPath() {
  return path.join(configDir(), 'audit.log');
}

export const LEVELS = ['info', 'notice', 'warning', 'alert'];
const ARGS_INLINE_BYTES = 64 * 1024;
const FIELD_CLIP = 4000;

const SECRETS = [
  /(?<!\d)\d{6,12}:[A-Za-z0-9_-]{25,}/g, // telegram bot tokens
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // github tokens
  /\bnpm_[A-Za-z0-9]{20,}\b/g, // npm tokens
  /\bpypi-[A-Za-z0-9_-]{20,}\b/g, // pypi tokens
  /\bsk-[A-Za-z0-9]{20,}\b/g, // api keys
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, // bearer credentials
  /\bAKIA[0-9A-Z]{16}\b/g, // aws access key ids
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const SENSITIVE_KEY = /token|secret|passw|authorization|api[_-]?key|cookie|credential/i;

/** Mask anything that looks like a credential, so the log never becomes a secret store. */
export function scrub(value, key = '') {
  if (typeof value === 'string') {
    if (SENSITIVE_KEY.test(key)) return '***';
    let out = value;
    for (const re of SECRETS) out = out.replace(re, '***');
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const masked = (key === 'env' || SENSITIVE_KEY.test(k)) && v !== null && typeof v !== 'object';
      out[k] = masked ? '***' : scrub(v, k);
    }
    return out;
  }
  return value;
}

/** The alert level of an entry: explicit level wins, otherwise derived from kind and status. */
export function levelFor({ kind = 'call', status = '', level } = {}) {
  if (level) return level;
  if (kind === 'auth' || (kind === 'approval' && status === 'forbidden')) return 'alert';
  if (kind === 'note') return status === 'ok' ? 'info' : 'warning';
  if (status === 'ok') return 'info';
  if (['trust', 'service', 'tunnel', 'log', 'approval'].includes(kind)) return 'notice';
  return 'warning';
}

function newEntryId(tool) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = String(tool || 'event').replace(/[^\w.-]/g, '_');
  return `${stamp}-${name}-${crypto.randomBytes(3).toString('hex')}`;
}

/** Long free-text fields other than the parameters are clipped; parameters are kept whole (see argsFor). */
function clipFields(value) {
  if (typeof value === 'string') return value.length > FIELD_CLIP ? `[${value.length} chars truncated]` : value;
  if (Array.isArray(value)) return value.map(clipFields);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = clipFields(v);
    return out;
  }
  return value;
}

/** Parameters are stored whole; the ones above the inline limit go to an artifact next to the entry. */
function argsFor(id, args) {
  if (args === undefined) return { args: {}, truncated: false };
  const clean = scrub(args);
  const json = JSON.stringify(clean);
  if (Buffer.byteLength(json) <= ARGS_INLINE_BYTES) return { args: clean, truncated: false };
  const saved = saveArtifact(id, 'args', 'args.json', JSON.stringify(clean, null, 2));
  return {
    args: { preview: json.slice(0, 2000) },
    truncated: true,
    artifact: saved ? 'args.json' : undefined,
  };
}

export function audit(entry = {}) {
  try {
    const dir = configDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // auto-rotate if over 10 MB (cheap stat, keeps log bounded)
    try { const st = fs.statSync(auditPath()); if (st.size > 10*1024*1024) rotateAuditIfNeeded(); } catch {}
    const { id, args, ...fields } = entry;
    const recId = String(id || newEntryId(fields.tool));
    const params = argsFor(recId, args);
    const body = clipFields(scrub({ kind: 'call', ...fields }));
    const rec = {
      id: recId,
      ts: new Date().toISOString(),
      ...body,
      level: levelFor({ kind: body.kind, status: body.status, level: body.level }),
      actor: body.actor || 'agent',
      source: body.source ?? null,
      args: params.args,
      args_truncated: params.truncated,
      ...(params.artifact ? { args_artifact: params.artifact } : {}),
    };
    fs.appendFileSync(auditPath(), JSON.stringify(rec) + '\n', { mode: 0o600 });
  } catch {
    /* auditing must never break the request */
  }
}

export function tailAudit(n = 50) {
  const file = auditPath();
  if (!fs.existsSync(file)) return [];
  // R6 fix: read from end, not whole file, to handle large audit.log
  try {
    const stat = fs.statSync(file);
    // if file small (<1MB), use simple path
    if (stat.size < 1024*1024) {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
    }
    // For large files, read last 512KB and get needed lines (reverse-read approximation)
    const fd = fs.openSync(file, 'r');
    const chunkSize = 512*1024;
    const start = Math.max(0, stat.size - chunkSize);
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').trim().split('\n').filter(Boolean);
    // If we didn't get enough due to truncation, fallback to reading more
    if (lines.length < n && start > 0) {
      const moreStart = Math.max(0, stat.size - chunkSize*4);
      const buf2 = Buffer.alloc(stat.size - moreStart);
      const fd2 = fs.openSync(file, 'r');
      fs.readSync(fd2, buf2, 0, buf2.length, moreStart);
      fs.closeSync(fd2);
      const lines2 = buf2.toString('utf8').trim().split('\n').filter(Boolean);
      return lines2.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
    }
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  } catch {
    // fallback to old method
    try {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
    } catch { return []; }
  }
}

export function rotateAuditIfNeeded(maxBytes = 10*1024*1024) {
  const file = auditPath();
  if (!fs.existsSync(file)) return;
  try {
    const stat = fs.statSync(file);
    if (stat.size > maxBytes) {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      // keep last 50% of lines
      const keep = lines.slice(Math.floor(lines.length/2));
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, keep.join('\n') + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
  } catch {}
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
