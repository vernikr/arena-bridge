import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-tunnel-'));
process.env.ARENA_BRIDGE_HOME = tmp;
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin, { recursive: true });

// A tunnel double: prints a quick-tunnel URL, then idles like the real thing.
// The file is named like the real binary, so process names match it exactly.
const cloudflared = path.join(bin, 'cloudflared');
fs.writeFileSync(cloudflared, '#!/bin/sh\necho "conn https://fake.trycloudflare.com" >&2\nsleep 30 </dev/null >/dev/null 2>&1 &\nwait\n', { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
const { startTunnel, killTunnelsForPort } = await import('../src/tunnel.mjs');
const { readPid, pidAlive, pidPath } = await import('../src/state.mjs');

// Silent double: a stderr write after the spawning call returns would kill it with SIGPIPE.
const silent = path.join(bin, 'silent.sh');
fs.writeFileSync(silent, '#!/bin/sh' + String.fromCharCode(10) + 'sleep 30 </dev/null >/dev/null 2>&1 &' + String.fromCharCode(10) + 'wait' + String.fromCharCode(10), { mode: 0o755 });

const spawn = (dir, port) => {
  fs.mkdirSync(dir, { recursive: true });
  const copy = path.join(dir, 'cloudflared');
  fs.copyFileSync(silent, copy);
  return Number(execFileSync('sh', ['-c',
    `${JSON.stringify(copy)} tunnel --url http://127.0.0.1:${port} --protocol http2 >/dev/null 2>&1 & echo $!`],
  { encoding: 'utf8' }).trim());
};

test('the pid file follows the live tunnel and dies with it', async () => {
  const tunnel = startTunnel({}, { bin: cloudflared, port: 8787, restarts: 0 });
  const url = await tunnel.urlPromise;
  assert.match(url, /trycloudflare\.com/);
  const pid = tunnel.child.pid;
  assert.equal(readPid('tunnel'), pid);
  assert.equal(tunnel.alive(), true);
  tunnel.kill();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(pidAlive(pid), false, 'the live tunnel process is stopped');
  assert.equal(fs.existsSync(pidPath('tunnel')), false, 'the pid file is gone');
  assert.equal(tunnel.alive(), false);
});

test('only tunnels of our port are stopped, by exact name', async () => {
  const ours = spawn(path.join(tmp, 'a'), 8787);
  const theirs = spawn(path.join(tmp, 'b'), 9999);
  await new Promise((r) => setTimeout(r, 200));
  const killed = killTunnelsForPort(8787);
  assert.ok(killed.includes(ours), 'our orphaned tunnel is stopped');
  assert.equal(pidAlive(theirs), true, 'a tunnel of another port keeps running');
  try { process.kill(theirs, 'SIGKILL'); } catch {}
});
