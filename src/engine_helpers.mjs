import { spawn } from 'node:child_process';

export function clip(buf, cap) {
  if (buf.length <= cap) return { data: buf, truncated: false };
  return { data: buf.subarray(0, cap), truncated: true };
}

export function runShell(command, { cwd, timeout, env, cap }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('/bin/sh', ['-lc', command], {
        cwd,
        env: { ...process.env, ...(env || {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (e) {
      resolve({ stdout: '', stderr: String(e.message), exit_code: -1, error: e.message });
      return;
    }
    const out = [];
    const err = [];
    let outLen = 0;
    let errLen = 0;
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    }, Math.max(1, timeout) * 1000);
    child.stdout.on('data', (c) => {
      if (outLen >= cap) { truncated = true; return; }
      const room = cap - outLen;
      const part = c.length > room ? c.subarray(0, room) : c;
      out.push(part); outLen += part.length;
      if (part.length < c.length) truncated = true;
    });
    child.stderr.on('data', (c) => {
      if (errLen >= cap) { truncated = true; return; }
      const room = cap - errLen;
      const part = c.length > room ? c.subarray(0, room) : c;
      err.push(part); errLen += part.length;
      if (part.length < c.length) truncated = true;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') + String(e.message), exit_code: -1, error: e.message, truncated, timed_out: timedOut });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), exit_code: code === null ? -1 : code, signal: signal || null, truncated, timed_out: timedOut });
    });
  });
}
