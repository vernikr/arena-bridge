import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.mjs';

function logDir() {
  return path.join(process.env.ARENA_BRIDGE_HOME || CONFIG_DIR, 'logs');
}
function logPath() {
  return path.join(logDir(), 'bridge.log');
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
function levelVal(l) { return LEVELS[String(l).toLowerCase()] ?? 20; }
function currentLevel() { return levelVal(process.env.LOG_LEVEL || process.env.ARENA_LOG_LEVEL || 'info'); }

export function log(level, msg, fields = {}) {
  if (levelVal(level) < currentLevel()) return;
  try {
    const dir = logDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const rec = {
      ts: new Date().toISOString(),
      level: String(level).toLowerCase(),
      msg: String(msg),
      ...fields,
      pid: process.pid,
    };
    // avoid logging secrets
    const out = JSON.stringify(rec);
    fs.appendFileSync(logPath(), out + '\n', { mode: 0o600 });
    // also rotate if needed
    try {
      const stat = fs.statSync(logPath());
      if (stat.size > 5 * 1024 * 1024) {
        const lines = fs.readFileSync(logPath(), 'utf8').trim().split('\n');
        const keep = lines.slice(Math.floor(lines.length / 2));
        fs.writeFileSync(logPath() + '.tmp', keep.join('\n') + '\n', { mode: 0o600 });
        fs.renameSync(logPath() + '.tmp', logPath());
      }
    } catch {}
  } catch {}
}

export function logInfo(msg, fields) { log('info', msg, fields); }
export function logWarn(msg, fields) { log('warn', msg, fields); }
export function logError(msg, fields) { log('error', msg, fields); }
export function logDebug(msg, fields) { log('debug', msg, fields); }
