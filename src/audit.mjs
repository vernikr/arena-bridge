import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, AUDIT_PATH } from './config.mjs';

export function audit(entry) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    const rec = { ts: new Date().toISOString(), ...entry };
    fs.appendFileSync(AUDIT_PATH, JSON.stringify(rec) + '\n', { mode: 0o600 });
  } catch {
    /* auditing must never break the request */
  }
}

export function tailAudit(n = 50) {
  if (!fs.existsSync(AUDIT_PATH)) return [];
  const lines = fs.readFileSync(AUDIT_PATH, 'utf8').trim().split('\n').filter(Boolean);
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
