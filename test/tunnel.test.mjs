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

test('cloudflared retries transient initial failures with bounded backoff', async () => {
  const counter = path.join(tmp, 'cloudflared-attempts');
  const retryBin = path.join(tmp, 'retry-cloudflared');
  fs.writeFileSync(retryBin, [
    '#!/bin/sh',
    'n=0',
    '[ -f ' + JSON.stringify(counter) + ' ] && n=$(cat ' + JSON.stringify(counter) + ')',
    'n=$((n + 1))',
    'echo $n > ' + JSON.stringify(counter),
    'if [ "$n" -lt 3 ]; then echo "dial tcp 198.41.0.1:7844: i/o timeout" >&2; exit 1; fi',
    'echo "https://retry-ok.trycloudflare.com" >&2',
    'sleep 30 </dev/null >/dev/null 2>&1 &',
    'wait',
  ].join('\n') + '\n', { mode: 0o755 });

  const retries = [];
  const tunnel = startTunnel({}, {
    bin: retryBin,
    port: 8789,
    restarts: 0,
    startupRetries: 3,
    retryBaseMs: 5,
    retryMaxMs: 10,
    random: () => 0,
    onRetry: (details) => retries.push(details),
  });
  const url = await tunnel.urlPromise;
  assert.equal(url, 'https://retry-ok.trycloudflare.com');
  assert.equal(Number(fs.readFileSync(counter, 'utf8').trim()), 3);
  assert.deepEqual(retries.map((r) => r.attempt), [1, 2]);
  assert.ok(retries.every((r) => r.category === 'edge_connectivity'));
  assert.deepEqual(retries.map((r) => r.delay), [4, 8]);
  tunnel.kill();
});

test('permanent cloudflared configuration failures fail without retrying', async () => {
  const retryBin = path.join(tmp, 'invalid-cloudflared');
  const marker = path.join(tmp, 'invalid-cloudflared-called');
  fs.writeFileSync(retryBin, '#!/bin/sh\necho called >> ' + JSON.stringify(marker) + '\necho "failed to parse tunnel credentials" >&2\nexit 1\n', { mode: 0o755 });
  const retries = [];
  const tunnel = startTunnel({}, {
    bin: retryBin,
    port: 8790,
    startupRetries: 5,
    retryBaseMs: 1,
    onRetry: (details) => retries.push(details),
  });
  const error = await tunnel.urlPromise.then(() => null, (reason) => reason);
  assert.match(error.message, /failed to parse tunnel credentials/);
  assert.equal(retries.length, 0);
  assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').length, 1);
  tunnel.kill();
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


test('startup failure preserves ngrok diagnostics and redacts the authtoken', async () => {
  const ngrok = path.join(bin, 'ngrok');
  fs.writeFileSync(
    ngrok,
    '#!/bin/sh\nprintf "ERR_NGROK_108: authtoken=example-sec" >&2\nsleep 0.1\nprintf "ret-token\\n" >&2\nexit 1\n',
    { mode: 0o755 },
  );

  let exitDetails;
  const tunnel = startTunnel({}, {
    bin: ngrok,
    port: 8788,
    authtoken: 'example-secret-token',
    restarts: 0,
    startupRetries: 0,
    onExit: (code, details) => { exitDetails = { code, ...details }; },
  });

  const error = await tunnel.urlPromise.then(() => null, (reason) => reason);
  assert.ok(error, 'the tunnel startup should fail');
  assert.match(error.message, /ERR_NGROK_108/);
  assert.doesNotMatch(error.message, /example-secret-token/);
  assert.match(error.message, /\[REDACTED\]/);
  assert.equal(exitDetails.code, 1);
  assert.equal(exitDetails.attempt, 1);
  assert.match(exitDetails.output, /ERR_NGROK_108/);
  assert.doesNotMatch(exitDetails.output, /example-secret-token/);
  tunnel.kill();
});
