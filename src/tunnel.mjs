import { spawn } from 'node:child_process';
import net from 'node:net';

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/**
 * Starts a cloudflared quick tunnel and resolves with the public URL it prints.
 * QUIC (UDP/7844) is blocked on many corporate/ISP networks, so we default to
 * http2 transport, which works over plain TCP/443.
 */
export function startTunnel(cfg, { port, protocol = 'http2', bin = 'cloudflared' } = {}) {
  const target = `http://127.0.0.1:${port}`;
  const args = ['tunnel', '--url', target, '--protocol', protocol];

  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let buffer = '';
  let settled = false;
  let resolveUrl;
  let rejectUrl;

  const urlPromise = new Promise((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });

  const onChunk = (chunk) => {
    const text = chunk.toString();
    buffer += text;
    const match = URL_RE.exec(buffer);
    if (match && !settled) {
      settled = true;
      resolveUrl(match[0]);
    }
  };

  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);

  child.on('error', (e) => {
    if (!settled) {
      settled = true;
      rejectUrl(new Error(`cannot start ${bin}: ${e.message}`));
    }
  });

  child.on('exit', (code) => {
    if (!settled) {
      settled = true;
      rejectUrl(new Error(`${bin} exited with code ${code} before the tunnel URL appeared`));
    }
  });

  return { child, urlPromise, args, target };
}

export function isPortOpen(port, host = '127.0.0.1', timeout = 700) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}
