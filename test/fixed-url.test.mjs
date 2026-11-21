import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin', 'arena-bridge.mjs');

test('fixed public URL skips Quick Tunnel and is used by health, prompt and url', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-fixed-url-'));
  const home = path.join(tmp, 'config');
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });

  const marker = path.join(tmp, 'cloudflared-was-called');
  const fakeTunnel = path.join(bin, 'cloudflared');
  fs.writeFileSync(fakeTunnel, '#!/bin/sh\nprintf called > ' + JSON.stringify(marker) + '\nexit 99\n', { mode: 0o755 });

  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const fixedUrl = 'https://bridge.example.test';
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    mode: 'direct',
    host: '127.0.0.1',
    port,
    token: 'agent-test-token',
    deviceToken: 'device-test-token',
    localToken: 'local-test-token',
    roots: [tmp],
    protected: [],
    fixedPublicUrl: fixedUrl,
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({
    publicUrl: 'https://old-random.trycloudflare.com',
  }, null, 2) + '\n');

  const env = {
    ...process.env,
    ARENA_BRIDGE_HOME: home,
    PATH: bin + path.delimiter + process.env.PATH,
  };
  const child = spawn(process.execPath, [cli, 'tunnel'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });

  try {
    let health = null;
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/health');
        if (response.ok) {
          health = await response.json();
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.ok(health, 'bridge API starts; output: ' + output);
    assert.equal(health.public_url, fixedUrl);
    assert.equal(health.has_public_url, true);
    assert.equal(health.tunnel_alive, null);

    const promptResponse = await fetch('http://127.0.0.1:' + port + '/prompt', {
      headers: { Authorization: 'Bearer agent-test-token' },
    });
    assert.equal(promptResponse.status, 200);
    assert.ok((await promptResponse.text()).includes(fixedUrl));

    const urlResult = spawnSync(process.execPath, [cli, 'url'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(urlResult.status, 0, urlResult.stderr);
    assert.equal(urlResult.stdout.trim(), fixedUrl);

    const savedConfig = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    const savedState = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
    assert.equal(savedConfig.fixedPublicUrl, fixedUrl);
    assert.equal(savedState.publicUrl, fixedUrl);
    assert.equal(fs.existsSync(marker), false, 'cloudflared must not be spawned');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

