import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG_DIR } from './config.mjs';

/** The config directory is resolved on every call so tests and relocations stay isolated. */
function configDir() {
  return process.env.ARENA_BRIDGE_HOME || CONFIG_DIR;
}

const ACTIVE = 'audit.log';
const ARCHIVE = /^audit-\d{13}\.log$/;

export function auditPath() {
  return path.join(configDir(), ACTIVE);
}

export const LEVELS = ['info', 'notice', 'warning', 'alert'];
const ARGS_INLINE_BYTES = 64 * 1024;
const FIELD_CLIP = 4000;
const ROTATE_BYTES = 5 * 1024 * 1024;
const RETAIN_DAYS = 7;
const RETAIN_BYTES = 20 * 1024 * 1024;
const ART_RETAIN_DAYS = 7;
const ART_RETAIN_BYTES = 200 * 1024 * 1024;
const READ_CHUNK = 256 * 1024;
const SCAN_BUDGET = 8 * 1024 * 1024;
const LEAN_DROP = ['args', 'result', 'output', 'stdout', 'stderr', 'content', 'body', 'data'];
const LEAN_CLIP = 300;

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
  if (['trust', 'service', 'tunnel', 'log', 'approval', 'step'].includes(kind)) return 'notice';
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
    // Keep only actions initiated by a human or an agent. Background housekeeping,
    // launchd lifecycle events, and unauthenticated/system probes are not user work.
    const actor = entry.actor || 'system';
    if (actor !== 'agent' && actor !== 'user') return;
    fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    const { id, args, ...fields } = { ...entry, actor };
    const recId = String(id || newEntryId(fields.tool));
    const params = argsFor(recId, args);
    const body = clipFields(scrub({ kind: 'call', ...fields }));
    const rec = {
      id: recId,
      ts: new Date().toISOString(),
      ...body,
      level: levelFor({ kind: body.kind, status: body.status, level: body.level }),
      actor: body.actor || 'system',
      source: body.source ?? null,
      args: params.args,
      args_truncated: params.truncated,
      ...(params.artifact ? { args_artifact: params.artifact } : {}),
    };
    const file = auditPath();
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', { mode: 0o600 });
    if (fs.statSync(file).size > ROTATE_BYTES) rotateAudit();
  } catch {
    /* auditing must never break the request */
  }
}

/* ------------------------------------------------------------------ *
 * segments: the active file plus closed archives, oldest first
 * ------------------------------------------------------------------ */

/** Last rotation only: maps the active file's previous name to its archive name, so open cursors survive it. */
const renamed = new Map();
const resolveName = (n) => renamed.get(n) || n;
const fileOf = (n) => path.join(configDir(), n);
const sizeOf = (n) => {
  try {
    return fs.statSync(fileOf(n)).size;
  } catch {
    return 0;
  }
};

export function segments() {
  let names = [];
  try {
    names = fs.readdirSync(configDir()).filter((f) => ARCHIVE.test(f)).sort();
  } catch {
    /* no log yet */
  }
  return [...names, ACTIVE];
}

const encode = (c) => (c ? Buffer.from(`${c.name}:${c.off}`).toString('base64url') : null);

function decode(token) {
  const m = /^(.+):(\d+)$/.exec(Buffer.from(String(token), 'base64url').toString('utf8'));
  if (!m || !(ARCHIVE.test(m[1]) || m[1] === ACTIVE)) return null;
  return { name: resolveName(m[1]), off: Number(m[2]) };
}

/** Cursor at the very beginning of the oldest segment. */
export function startCursor() {
  return encode({ name: segments()[0], off: 0 });
}

/** Cursor at the current end of the active file: new records are after it. */
export function headCursor() {
  return encode({ name: ACTIVE, off: sizeOf(ACTIVE) });
}

/** Complete lines of one file, from the end backwards: { text, start, end } with byte offsets. */
function* backLines(file, end) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return;
  }
  try {
    let pos = end;
    let carry = Buffer.alloc(0);
    for (;;) {
      const from = Math.max(0, pos - READ_CHUNK);
      const chunk = Buffer.alloc(pos - from);
      if (chunk.length) fs.readSync(fd, chunk, 0, chunk.length, from);
      pos = from;
      const buf = Buffer.concat([chunk, carry]);
      let hi = buf.length;
      let i = hi > 0 ? buf.lastIndexOf(0x0a, hi - 1) : -1;
      while (i !== -1) {
        const s = i + 1;
        if (hi > s) yield { text: buf.toString('utf8', s, hi), start: from + s, end: from + hi + 1 };
        hi = i;
        i = hi > 0 ? buf.lastIndexOf(0x0a, hi - 1) : -1;
      }
      carry = buf.subarray(0, hi);
      if (from === 0) {
        if (carry.length) yield { text: carry.toString('utf8'), start: 0, end: carry.length };
        return;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Complete lines of one file, from an offset forwards, up to `budget` bytes. */
function forwardLines(name, off, budget) {
  const out = [];
  let fd;
  try {
    fd = fs.openSync(fileOf(name), 'r');
  } catch {
    return { lines: out, eof: true };
  }
  try {
    const size = fs.fstatSync(fd).size;
    let pos = off;
    let used = 0;
    while (pos < size && used < budget) {
      let n = Math.min(READ_CHUNK, size - pos);
      let buf;
      let last;
      for (;;) {
        buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, pos);
        last = buf.lastIndexOf(0x0a);
        if (last !== -1 || pos + n >= size) break;
        n = Math.min(n * 2, size - pos);
      }
      if (last === -1) break;
      let s = 0;
      while (s <= last && used < budget) {
        const e = buf.indexOf(0x0a, s);
        out.push({ text: buf.toString('utf8', s, e), end: pos + e + 1 });
        used += e + 1 - s;
        s = e + 1;
      }
      pos += s;
      if (s <= last) break;
    }
    return { lines: out, eof: pos >= size };
  } finally {
    fs.closeSync(fd);
  }
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * One page of the log. Default: the newest `limit` records, oldest first, with `next` (older page).
 * `before` pages further back. `after` reads forward from a cursor (new records).
 */
export function auditPage({ limit = 100, before, after, tool, kind, level } = {}) {
  const minLevel = level ? LEVELS.indexOf(level) : -1;
  if (level && minLevel < 0) return { error: 'invalid level', entries: [], next: null, has_more: false };
  const want = (rec) =>
    (!tool || rec.tool === tool) && (!kind || rec.kind === kind) && (minLevel < 0 || LEVELS.indexOf(rec.level) >= minLevel);
  const names = segments();
  const out = [];
  let scanned = 0;

  if (after) {
    const c = decode(after);
    if (!c) return { error: 'invalid cursor', entries: [], next: null, has_more: false };
    let ci = names.indexOf(c.name);
    if (ci < 0) return { entries: [], next: headCursor(), has_more: false, reset: true };
    let off = c.off;
    let cur = c;
    for (;;) {
      const f = forwardLines(names[ci], off, SCAN_BUDGET - scanned);
      for (const ln of f.lines) {
        scanned += ln.end - off;
        off = ln.end;
        cur = { name: names[ci], off };
        const rec = parse(ln.text);
        if (rec && want(rec)) {
          out.push(rec);
          if (out.length >= limit) break;
        }
      }
      if (out.length >= limit || scanned >= SCAN_BUDGET) break;
      if (f.eof && ci < names.length - 1) {
        ci++;
        off = 0;
        cur = { name: names[ci], off: 0 };
        continue;
      }
      break;
    }
    const more = !(names.indexOf(cur.name) === names.length - 1 && cur.off >= sizeOf(ACTIVE));
    return { entries: out, next: encode(cur), has_more: more, reset: false };
  }

  let ci = names.length - 1;
  let off = sizeOf(names[ci]);
  if (before) {
    const c = decode(before);
    if (!c) return { error: 'invalid cursor', entries: [], next: null, has_more: false };
    ci = names.indexOf(c.name);
    if (ci < 0) return { entries: [], next: null, has_more: false, reset: true };
    off = c.off;
  }
  let cur = null;
  outer: while (ci >= 0) {
    for (const ln of backLines(fileOf(names[ci]), off)) {
      cur = { name: names[ci], off: ln.start };
      scanned += ln.end - ln.start;
      const rec = parse(ln.text);
      if (rec && want(rec)) {
        out.push(rec);
        if (out.length >= limit) break outer;
      }
      if (scanned >= SCAN_BUDGET) break outer;
    }
    ci--;
    if (ci >= 0) off = sizeOf(names[ci]);
  }
  const done = ci < 0;
  const more = !done && !(cur && cur.name === names[0] && cur.off === 0);
  return { entries: out.reverse(), next: more ? encode(cur) : null, has_more: more, reset: false };
}

export function tailAudit(n = 50) {
  return auditPage({ limit: n }).entries;
}

/** The record with this id, searched newest first, or null. */
export function findEntry(id) {
  const names = segments();
  for (let ci = names.length - 1; ci >= 0; ci--) {
    for (const ln of backLines(fileOf(names[ci]), sizeOf(names[ci]))) {
      if (!ln.text.includes(id)) continue;
      const rec = parse(ln.text);
      if (rec && rec.id === id) return rec;
    }
  }
  return null;
}

/** The API view of a record: no parameters or bulky output, long strings clipped, plus a short args preview. */
export function lean(rec) {
  const out = {};
  for (const [k, v] of Object.entries(rec)) {
    if (LEAN_DROP.includes(k)) continue;
    out[k] = typeof v === 'string' && v.length > LEAN_CLIP ? `${v.slice(0, LEAN_CLIP)}…` : v;
  }
  if (rec.args !== undefined) out.args_preview = JSON.stringify(rec.args).slice(0, 200);
  return out;
}

/** Close the active file into an archive. The newest archive is never removed by retention. */
export function rotateAudit(now = Date.now()) {
  const file = auditPath();
  if (!fs.existsSync(file)) return null;
  let ms = now;
  let name;
  do {
    name = `audit-${String(ms).padStart(13, '0')}.log`;
    ms++;
  } while (fs.existsSync(fileOf(name)));
  fs.renameSync(file, fileOf(name));
  renamed.set(ACTIVE, name);
  pruneAudit();
  return name;
}

/** Delete archives older than `days`, then the oldest ones while the total is above `maxBytes`. */
export function pruneAudit({ days = RETAIN_DAYS, maxBytes = RETAIN_BYTES, now = Date.now() } = {}) {
  const archives = segments()
    .slice(0, -1)
    .map((name) => {
      try {
        const st = fs.statSync(fileOf(name));
        return { name, size: st.size, mtime: st.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  let total = archives.reduce((s, f) => s + f.size, sizeOf(ACTIVE));
  const cutoff = now - Number(days) * 86400000;
  let removed = 0;
  let freed = 0;
  for (let i = 0; i < archives.length - 1; i++) {
    const f = archives[i];
    if (f.mtime >= cutoff && total <= maxBytes) break;
    fs.rmSync(fileOf(f.name), { force: true });
    total -= f.size;
    freed += f.size;
    removed++;
  }
  return { removed, freed_bytes: freed };
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

function dirBytes(sub) {
  let n = 0;
  try {
    for (const f of fs.readdirSync(sub)) {
      try {
        n += fs.statSync(path.join(sub, f)).size;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return n;
}

/** Remove artifact folders older than `days`, then the oldest while the total is above `maxBytes`. */
export function pruneArtifacts(days = ART_RETAIN_DAYS, maxBytes = ART_RETAIN_BYTES) {
  const dir = auditDir();
  if (!fs.existsSync(dir)) return { removed: 0, freed_bytes: 0 };
  const cutoff = Date.now() - Number(days) * 86400000;
  const folders = [];
  for (const entry of fs.readdirSync(dir)) {
    const sub = path.join(dir, entry);
    try {
      const st = fs.statSync(sub);
      if (st.isDirectory()) folders.push({ sub, mtime: st.mtimeMs, size: dirBytes(sub) });
    } catch {
      /* ignore */
    }
  }
  folders.sort((a, b) => a.mtime - b.mtime);
  let total = folders.reduce((s, f) => s + f.size, 0);
  let removed = 0;
  let freed = 0;
  for (const f of folders) {
    if (f.mtime >= cutoff && total <= maxBytes) break;
    fs.rmSync(f.sub, { recursive: true, force: true });
    total -= f.size;
    freed += f.size;
    removed++;
  }
  return { removed, freed_bytes: freed };
}
