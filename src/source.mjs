import dns from 'node:dns/promises';
import net from 'node:net';

const HOST_BUDGET_MS = 250;
const HOST_TTL_MS = 60 * 60 * 1000;
const HOST_MISS_TTL_MS = 5 * 60 * 1000;
const UNAUTH_WINDOW_MS = 60 * 1000;
const UNAUTH_LINES = 5;
const CACHE_LIMIT = 1000;

const hosts = new Map(); // ip -> { host, expires }
const unauth = new Map(); // ip -> { start, count, logged }

const isLocal = (ip) =>
  !ip || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fe80|fc|fd)/i.test(ip);

/** The caller's address: set by the tunnel edge, or the socket for local requests. */
export function clientIp(req) {
  const header = req.headers['cf-connecting-ip'];
  const candidates = [typeof header === 'string' ? header.trim() : '', req.socket?.remoteAddress || ''];
  for (const raw of candidates) {
    const ip = raw.replace(/^::ffff:/, '');
    if (net.isIP(ip)) return ip;
  }
  return null;
}

/** Describe the caller without any network lookup. */
export function describeSource(req, channel) {
  const ip = clientIp(req);
  const country = typeof req.headers['cf-ipcountry'] === 'string' ? req.headers['cf-ipcountry'].slice(0, 2) : null;
  const agent = String(req.headers['user-agent'] || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
  return { channel, ip, country, host: null, client: agent || null };
}

/** Reverse-DNS name of an address, within a short budget and cached. Null when unknown. */
export async function lookupHost(ip, now = Date.now()) {
  if (isLocal(ip)) return null;
  const hit = hosts.get(ip);
  if (hit && hit.expires > now) return hit.host;
  let host = null;
  try {
    const names = await Promise.race([
      dns.reverse(ip),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), HOST_BUDGET_MS).unref()),
    ]);
    host = names?.[0] || null;
  } catch {
    host = null;
  }
  if (hosts.size >= CACHE_LIMIT) hosts.clear();
  hosts.set(ip, { host, expires: now + (host ? HOST_TTL_MS : HOST_MISS_TTL_MS) });
  return host;
}

/** A full source description, including the reverse-DNS name. */
export async function sourceOf(req, channel) {
  const source = describeSource(req, channel);
  source.host = await lookupHost(source.ip);
  return source;
}

/**
 * Failed-authentication bookkeeping per address: the first lines of each minute are logged,
 * the rest is counted and reported once when the minute ends.
 */
export function admitUnauthorized(ip, now = Date.now()) {
  const key = ip || 'unknown';
  let w = unauth.get(key);
  let previousSuppressed = 0;
  if (!w || now - w.start >= UNAUTH_WINDOW_MS) {
    if (w && w.count > w.logged) previousSuppressed = w.count - w.logged;
    if (unauth.size >= CACHE_LIMIT) unauth.clear();
    w = { start: now, count: 0, logged: 0 };
    unauth.set(key, w);
  }
  w.count += 1;
  const write = w.logged < UNAUTH_LINES;
  if (write) w.logged += 1;
  return { write, count: w.count, previousSuppressed };
}
