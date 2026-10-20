import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const NGROK_URL_RE = /https:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.(?:app|io|dev)/i;

/**
 * Starts a tunnel and resolves with the public URL it prints.
 * cloudflared: QUIC (UDP/7844) is blocked on many networks, so we default to http2 over TCP/443.
 * ngrok: an authtoken and an optional reserved domain give the same URL on every restart.
 */
/**
 * An old ngrok process keeps the reserved domain, and the new one cannot take it. Only the
 * processes that serve our domain are stopped, never the other tunnels of the user.
 */
export function killStaleNgrok(domain) {
  if (!domain) return [];
  const killed = [];
  let pids = [];
  try {
    pids = execFileSync('pgrep', ['-x', 'ngrok'], { encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return killed;
  }
  for (const pid of pids) {
    let args = '';
    try {
      args = execFileSync('ps', ['-o', 'args=', '-p', pid], { encoding: 'utf8' });
    } catch {
      continue;
    }
    if (!args.includes(domain)) continue;
    try {
      process.kill(Number(pid), 'SIGTERM');
      killed.push(Number(pid));
    } catch {
      /* already gone */
    }
  }
  return killed;
}

export function startTunnel(
  cfg,
  { port, protocol = 'http2', bin = 'cloudflared', authtoken, domain, restarts = 20, delay = 2000, onExit } = {},
) {
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

  let child = null;
  let buffer = '';
  let settled = false;
  let attempt = 0;
  let resolveUrl;
  let rejectUrl;
  const listeners = new Set();

  const urlPromise = new Promise((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });

  const onChunk = (chunk) => {
    buffer += chunk.toString();
    const match = urlPattern.exec(buffer);
    if (!match) return;
    if (!settled) {
      settled = true;
      resolveUrl(match[0]);
    }
    for (const fn of listeners) fn(match[0]);
  };

  const spawnChild = () => {
    child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    buffer = '';
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', (e) => {
      if (!settled) {
        settled = true;
        rejectUrl(new Error(`cannot start ${bin}: ${e.message}`));
      }
    });
    child.on('close', (code) => {
      onExit?.(code);
      if (!settled) {
        if (isNgrok && attempt++ < restarts) {
          killStaleNgrok(domain);
          setTimeout(spawnChild, delay);
          return;
        }
        settled = true;
        rejectUrl(new Error(`${bin} exited with code ${code} before the tunnel URL appeared`));
        return;
      }
      if (attempt++ < restarts) {
        setTimeout(spawnChild, delay);
      }
    });
  };

  spawnChild();

  return {
    child,
    urlPromise,
    args,
    target,
    onUrl: (fn) => listeners.add(fn),
  };
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
