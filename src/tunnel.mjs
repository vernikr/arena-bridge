import { spawn } from 'node:child_process';
import net from 'node:net';

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const NGROK_URL_RE = /https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.(?:app|io|dev)/i;

/**
 * Starts a tunnel and resolves with the public URL it prints.
 * cloudflared: QUIC (UDP/7844) is blocked on many networks, so we default to http2 over TCP/443.
 * ngrok: an authtoken and an optional reserved domain give the same URL on every restart.
 */
export function startTunnel(cfg, { port, protocol = 'http2', bin = 'cloudflared', authtoken, domain } = {}) {
  const target = `http://127.0.0.1:${port}`;
  const isNgrok = /ngrok/i.test(bin);
  const args = isNgrok
    ? [
        'http',
        target,
        ...(authtoken ? ['--authtoken', String(authtoken)] : []),
        ...(domain ? ['--domain', String(domain)] : []),
        '--log',
        'stdout',
      ]
    : ['tunnel', '--url', target, '--protocol', protocol];
  const urlPattern = isNgrok ? NGROK_URL_RE : URL_RE;

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
    const match = urlPattern.exec(buffer);
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
