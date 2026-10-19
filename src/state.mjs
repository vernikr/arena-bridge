import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, CONFIG_PATH } from './config.mjs';

export const STATE_PATH = path.join(CONFIG_DIR, 'state.json');

export function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    }
  } catch {}
  return {};
}

export function saveState(patch) {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch {}
  // migrate publicUrl from config.json if present and not in state
  if (!cur.publicUrl && fs.existsSync(CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (cfg.publicUrl) {
        cur.publicUrl = cfg.publicUrl;
        // remove from config to complete migration (best effort)
        try {
          const out = { ...cfg };
          delete out.publicUrl;
          const tmp = CONFIG_PATH + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
          fs.renameSync(tmp, CONFIG_PATH);
        } catch {}
      }
    } catch {}
  }
  const next = { ...cur, ...patch };
  const tmp = STATE_PATH + '.tmp';
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, STATE_PATH);
  return next;
}

export function clearStateKey(key) {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch {}
  if (key in cur) {
    delete cur[key];
    const tmp = STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cur, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, STATE_PATH);
  }
}
