import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, CONFIG_PATH, readJsonWithRecovery } from './config.mjs';

export const STATE_PATH = path.join(CONFIG_DIR, 'state.json');

export function loadState() {
  try {
    if (fs.existsSync(STATE_PATH) || fs.existsSync(`${STATE_PATH}.tmp`)) {
      return readJsonWithRecovery(STATE_PATH);
    }
  } catch {}
  return {};
}

export function saveState(patch) {
  let cur = {};
  try { cur = readJsonWithRecovery(STATE_PATH); } catch {}
  // migrate publicUrl from config.json if present and not in state
  if (!cur.publicUrl && fs.existsSync(CONFIG_PATH)) {
    try {
      const cfg = readJsonWithRecovery(CONFIG_PATH);
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

/* ------------------------------------------------------------------ *
 * pid files: the service and its tunnel outlive a SIGKILLed parent, so
 * every generation records where it lives and the next one cleans up
 * ------------------------------------------------------------------ */

import { execFileSync } from 'node:child_process';

export const pidPath = (name) => path.join(CONFIG_DIR, `${name}.pid`);

export function writePid(name, pid = process.pid) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(pidPath(name), String(pid), { mode: 0o600 });
  } catch {}
  return pid;
}

export function readPid(name) {
  try {
    const pid = Number(fs.readFileSync(pidPath(name), 'utf8').trim()) || 0;
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function clearPid(name, pid) {
  try {
    if (pid === undefined || readPid(name) === pid) fs.rmSync(pidPath(name), { force: true });
  } catch {}
}

/** True while the process exists, whatever its state. */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** The executable name of a process, empty when it is gone; used to never kill a foreign one. */
export function pidName(pid) {
  try {
    return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** The parent pid of a process, 0 when it is gone; 1 means the original parent died. */
export function pidParent(pid) {
  try {
    return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()) || 0;
  } catch {
    return 0;
  }
}

/** The whole command line of a process, empty when it is gone. */
export function pidArgs(pid) {
  try {
    return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** SIGTERM a process and wait for it to leave, without ever following it into the grave. */
export function stopPid(pid, waitMs = 3000) {
  if (!pid || !pidAlive(pid)) return false;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  const end = Date.now() + waitMs;
  while (Date.now() < end && pidAlive(pid)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  return !pidAlive(pid);
}

export function clearStateKey(key) {
  let cur = {};
  try { cur = readJsonWithRecovery(STATE_PATH); } catch {}
  if (key in cur) {
    delete cur[key];
    const tmp = STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cur, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, STATE_PATH);
  }
}
