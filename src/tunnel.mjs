import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import { writePid, clearPid, readPid, pidAlive, pidName, stopPid } from './state.mjs';

/** Tunnel binaries this bridge may stop; anything else on the machine is untouchable. */
export const TUNNEL_NAMES = ['cloudflared', 'ngrok'];

/** Stop a tunnel of a previous generation from its pid file, never a foreign process. */
export function killStaleTunnel() {
  const pid = readPid('tunnel');
  if (!pid || !pidAlive(pid)) return null;
  const name = pidName(pid).split('/').pop();
  if (!TUNNEL_NAMES.includes(name)) return null;
  stopPid(pid);
  clearPid('tunnel', pid);
  return pid;
}

/** The pid listening on a TCP port, via lsof; null when the port is free or lsof is missing. */
export function listenerPid(port) {
  try {
    const out = execFileSync('lsof', ['-t', '-i', `TCP:${port}`, '-s', 'TCP:LISTEN'], { encoding: 'utf8' });
    return Number(out.split('\n')[0].trim()) || null;
  } catch {
    return null;
  }
}

/**
 * Pids of tunnel processes: the name column matches a tunnel binary (by basename, since
 * macOS reports interpreted commands with their path), optionally aimed at one local port.
 */
export function tunnelProcesses(port) {
  let text = '';
  try {
    text = execFileSync('ps', ['-ax', '-o', 'pid=,comm=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\S.*)$/.exec(line);
    if (!m) continue;
    const name = m[2].split('/').pop();
    if (!TUNNEL_NAMES.includes(name)) continue;
    if (port !== undefined && !m[3].includes(`127.0.0.1:${port}`)) continue;
    out.push(Number(m[1]));
  }
  return out;
}

/**
 * Stop tunnel processes that serve exactly our local port: orphaned tunnels of a dead
 * bridge generation. Tunnels of the user that point elsewhere keep running.
 */
export function killTunnelsForPort(port) {
  const killed = [];
  for (const pid of tunnelProcesses(port)) {
    stopPid(pid);
    if (readPid('tunnel') === pid) clearPid('tunnel', pid);
    killed.push(pid);
  }
  return killed;
}

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
  let exhausted = false;
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
    if (child.pid) writePid('tunnel', child.pid);
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
      const mine = child;
      if (!settled) {
        if (!exhausted && isNgrok && attempt++ < restarts) {
          killStaleNgrok(domain);
          setTimeout(spawnChild, delay);
          return;
        }
        settled = true;
        rejectUrl(new Error(`${bin} exited with code ${code} before the tunnel URL appeared`));
        return;
      }
      if (!exhausted && attempt++ < restarts) {
        setTimeout(spawnChild, delay);
        return;
      }
      // No restart left: the tunnel stays down and the pid file must not point at a corpse.
      exhausted = true;
      if (child === mine) clearPid('tunnel', mine.pid);
    });
  };

  spawnChild();

  return {
    urlPromise,
    args,
    target,
    onUrl: (fn) => listeners.add(fn),
    /** The live tunnel process, so a stop never kills a corpse and orphans a real one. */
    get child() {
      return child;
    },
    /** True while the current tunnel process is alive and restarts are not spent. */
    alive: () => !!child && !exhausted && child.exitCode === null && child.signalCode === null,
    /** True once every restart is spent and the tunnel stays down. */
    spent: () => exhausted,
    kill: () => {
      exhausted = true;
      const pid = child?.pid;
      if (pid) clearPid('tunnel', pid);
      try {
        child?.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      return !!pid;
    },
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
