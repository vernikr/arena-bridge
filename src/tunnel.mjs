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
 * Pids of tunnel processes, optionally aimed at one local port. The first command line
 * tokens name the binary: on macOS an interpreted command carries the interpreter first
 * and the script path second, so both tokens are checked by basename.
 */
export function tunnelProcesses(port) {
  let text = '';
  try {
    text = execFileSync('ps', ['-ax', '-o', 'pid=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\S.*)$/.exec(line);
    if (!m) continue;
    const args = m[2];
    const head = args.split(/\s+/).slice(0, 2).map((t) => t.split('/').pop());
    if (!head.some((name) => TUNNEL_NAMES.includes(name))) continue;
    if (port !== undefined && !args.includes(`127.0.0.1:${port}`)) continue;
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

export function classifyTunnelFailure(error) {
  const message = String(error?.message || error || '');
  const code = String(error?.code || '');
  if (code === 'ENOENT' || /cannot start .*ENOENT/i.test(message)) return 'missing_binary';
  if (/ERR_NGROK_9040|authtoken|authentication failed|unauthorized|invalid credentials|failed to parse|unknown flag|permission denied/i.test(message)) return 'configuration';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS lookup/i.test(code + ' ' + message)) return 'dns';
  if (/timeout|timed out|dial tcp|connection refused|connection reset|network is unreachable|7844|connect/i.test(message)) return 'edge_connectivity';
  return 'startup';
}

function permanentStartupFailure(error) {
  const message = String(error?.message || error || '');
  const code = String(error?.code || '');
  return ['ENOENT', 'EACCES', 'EPERM', 'EINVAL'].includes(code)
    || /ERR_NGROK_9040|authtoken|authentication failed|unauthorized|invalid credentials|failed to parse|unknown flag|permission denied/i.test(message);
}

function redactTunnelOutput(value, authtoken) {
  let text = String(value)
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u0000/g, '');
  if (authtoken) text = text.split(String(authtoken)).join('[REDACTED]');
  return text
    .replace(/(--authtoken(?:=|\s+))\S+/gi, '$1[REDACTED]')
    .replace(/(authtoken["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1[REDACTED]');
}

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
  { port, protocol = 'http2', bin = 'cloudflared', authtoken, domain, restarts = 20, delay = 2000, startupRetries = 5, retryBaseMs = 1000, retryMaxMs = 15000, random = Math.random, onRetry, onExit } = {},
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
  let diagnosticTail = '';
  let settled = false;
  let urlResolved = false;
  let attempt = 0;
  let startupAttempts = 0;
  let retryScheduled = false;
  let retryTimer = null;
  let exhausted = false;
  let resolveUrl;
  let rejectUrl;
  const listeners = new Set();

  const urlPromise = new Promise((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });

  const onChunk = (chunk) => {
    const text = chunk.toString()
      .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\u0000/g, '');
    const combined = buffer + text;
    const match = urlPattern.exec(combined);
    buffer = combined.slice(-8192);
    // Keep the raw bounded tail until chunks have been reassembled. Redaction on
    // individual chunks can miss a credential split across two stream events.
    diagnosticTail = (diagnosticTail + text).slice(-4000);
    if (!match) return;
    if (!settled) {
      settled = true;
      urlResolved = true;
      resolveUrl(match[0]);
    }
    for (const fn of listeners) fn(match[0]);
  };

  const scheduleStartupRetry = (error) => {
    if (retryScheduled) return true;
    if (settled || urlResolved || startupAttempts >= startupRetries || permanentStartupFailure(error)) return false;
    startupAttempts++;
    retryScheduled = true;
    const base = Math.min(retryMaxMs, retryBaseMs * (2 ** (startupAttempts - 1)));
    const jitter = Math.max(0, Math.min(1, Number(random()) || 0));
    const wait = Math.round(base * (0.8 + jitter * 0.4));
    const reason = String(error?.message || error || 'tunnel exited before URL appeared').slice(0, 400);
    try { onRetry?.({ attempt: startupAttempts, delay: wait, category: classifyTunnelFailure(error), reason }); } catch {}
    if (isNgrok) killStaleNgrok(domain);
    retryTimer = setTimeout(() => {
      retryScheduled = false;
      spawnChild();
    }, wait);
    return true;
  };

  const spawnChild = () => {
    if (exhausted || (settled && !urlResolved)) return;
    child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const mine = child;
    if (mine.pid) writePid('tunnel', mine.pid);
    buffer = '';
    mine.stdout.on('data', onChunk);
    mine.stderr.on('data', onChunk);
    mine.on('error', (error) => {
      if (urlResolved || settled) return;
      const failure = new Error('cannot start ' + bin + ': ' + error.message);
      failure.code = error.code;
      if (scheduleStartupRetry(failure)) return;
      settled = true;
      rejectUrl(failure);
    });
    mine.on('close', (code) => {
      if (child !== mine) return;
      const output = redactTunnelOutput(diagnosticTail.trim(), authtoken).slice(-2000);
      const newline = String.fromCharCode(10);
      const suffix = output ? newline + 'Last output from ' + bin + ':' + newline + output : '';
      const failure = new Error(bin + ' exited with code ' + code + ' before the tunnel URL appeared' + suffix);
      onExit?.(code, {
        attempt: startupAttempts + attempt + 1,
        output,
        category: urlResolved ? 'runtime' : classifyTunnelFailure(failure),
      });
      if (!urlResolved) {
        if (settled) return;
        if (scheduleStartupRetry(failure)) return;
        settled = true;
        rejectUrl(failure);
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
      if (retryTimer) clearTimeout(retryTimer);
      retryScheduled = false;
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
