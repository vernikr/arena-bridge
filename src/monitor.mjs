import { sendTelegram } from './telegram.mjs';
import { logInfo, logWarn, logError } from './log.mjs';

function errorCode(error) {
  let current = error;
  for (let i = 0; i < 4 && current; i++, current = current.cause) {
    if (current.code) return String(current.code).toUpperCase();
  }
  return '';
}

export function classifyHealthError(error, endpoint = 'public_endpoint') {
  const code = errorCode(error);
  const message = String(error?.message || error || '');
  if (['ENOTFOUND', 'EAI_AGAIN', 'ENODATA', 'ESERVFAIL'].includes(code) || /getaddrinfo|DNS lookup/i.test(message)) {
    return { code: 'dns', hint: 'DNS resolution failed; inspect the configured resolver and domain records' };
  }
  if (/CERT_|TLS|SSL|certificate/i.test(code + ' ' + message)) {
    return { code: 'tls', hint: 'TLS negotiation or certificate validation failed' };
  }
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)
    || /connect timeout|network is unreachable|socket hang up/i.test(message)) {
    return endpoint === 'local_api'
      ? { code: 'local_api_unavailable', hint: 'Could not connect to the local API; check the bridge process, host, and port' }
      : { code: 'edge_connectivity', hint: 'Could not establish the HTTPS connection; inspect the route to Cloudflare Edge' };
  }
  return { code: 'request_failed', hint: 'Inspect the network error details and endpoint availability' };
}

function healthUrl(base) {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || !url.host) throw new Error('invalid public URL');
  const currentPath = url.pathname.replace(/\/+$/, '');
  url.pathname = currentPath.endsWith('/health') ? currentPath : currentPath + '/health';
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function probe(url, name, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) {
      const serverHeader = String(response.headers?.get?.('server') || '').toLowerCase();
      const cloudflare = serverHeader.includes('cloudflare') || response.headers?.has?.('cf-ray');
      const code = cloudflare || [520, 521, 522, 523, 524, 525, 526, 530].includes(response.status)
        ? 'cloudflare_edge'
        : 'http_status';
      return {
        name,
        ok: false,
        code,
        detail: 'HTTP ' + response.status + (response.statusText ? ' ' + response.statusText : ''),
        hint: code === 'cloudflare_edge'
          ? 'Cloudflare returned an edge/origin error; check the named tunnel and its connection to the local API'
          : 'The endpoint returned a non-success HTTP status',
        status: response.status,
      };
    }
    let body;
    try { body = await response.json(); } catch {
      return { name, ok: false, code: 'invalid_health_response', detail: 'HTTP 200 but response is not JSON', hint: 'Check that this URL points to the Arena Bridge /health endpoint', status: response.status };
    }
    if (body?.ok !== true) {
      return { name, ok: false, code: 'invalid_health_response', detail: 'HTTP 200 but health payload does not contain ok: true', hint: 'Check that the public URL routes to the expected Arena Bridge instance', status: response.status };
    }
    return { name, ok: true, code: name, detail: 'HTTP ' + response.status + ' • Arena Bridge healthy', status: response.status };
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { name, ok: false, code: name === 'public_endpoint' ? 'edge_connectivity' : 'local_api_timeout', detail: 'request timed out after ' + timeoutMs + ' ms', hint: name === 'public_endpoint' ? 'The HTTPS request to Cloudflare Edge timed out' : 'The local API did not respond within the timeout' };
    }
    const classified = classifyHealthError(error, name);
    return { name, ok: false, ...classified, detail: (error?.message || String(error)).slice(0, 240) };
  } finally {
    clearTimeout(timer);
  }
}

/** Check both ends independently so a public failure can be separated from a local API failure. */
export async function checkRemoteHealth({
  localUrl,
  publicUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
} = {}) {
  const checks = [];
  if (!localUrl) {
    checks.push({ name: 'local_api', ok: false, code: 'local_url_missing', detail: 'local API URL is not configured', hint: 'Set the local API host and port' });
  } else {
    checks.push(await probe(localUrl, 'local_api', fetchImpl, timeoutMs));
  }
  if (!publicUrl) {
    checks.push({ name: 'public_endpoint', ok: false, code: 'public_url_missing', detail: 'public URL is not configured', hint: 'Set fixedPublicUrl or start a tunnel' });
  } else {
    let url;
    try { url = healthUrl(publicUrl); } catch {
      checks.push({ name: 'public_endpoint', ok: false, code: 'invalid_public_url', detail: 'public URL is invalid', hint: 'Check fixedPublicUrl in config.json' });
      return { ok: checks.every((c) => c.ok), checks };
    }
    checks.push(await probe(url, 'public_endpoint', fetchImpl, timeoutMs));
  }
  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * Monitor the externally managed public URL from the same machine that hosts the API.
 * Alerts once after a configurable run of failures, then sends a recovery notice.
 */
export function startRemoteMonitor({
  cfg,
  localUrl,
  publicUrl,
  intervalMs = 60_000,
  failureThreshold = 3,
  timeoutMs = 5000,
  fetchImpl = globalThis.fetch,
  notify,
  onCheck,
  runImmediately = true,
} = {}) {
  const notifyFn = notify || (cfg?.telegram?.enabled ? (message) => sendTelegram(cfg, { title: 'arena-bridge monitor', text: message }) : null);
  let failures = 0;
  let alerted = false;
  let running = false;
  let stopped = false;

  const check = async () => {
    if (stopped || running) return null;
    running = true;
    try {
      const result = await checkRemoteHealth({ localUrl, publicUrl, fetchImpl, timeoutMs });
      onCheck?.(result);
      if (result.ok) {
        if (failures > 0) {
          logInfo('remote endpoint recovered', { previous_failures: failures });
          if (alerted && notifyFn) {
            try {
              const sent = await notifyFn('Публичный адрес Arena Bridge снова доступен. Локальный API и HTTPS endpoint отвечают штатно.');
              if (sent && sent.ok === false) logWarn('monitor recovery notification failed', { reason: sent.reason || sent.error });
            } catch (error) { logWarn('monitor recovery notification failed', { error: String(error?.message || error) }); }
          }
        }
        failures = 0;
        alerted = false;
        return result;
      }

      failures++;
      logWarn('remote endpoint check failed', {
        consecutive_failures: failures,
        checks: result.checks.filter((c) => !c.ok).map(({ code, detail }) => ({ code, detail })),
      });
      if (failures >= failureThreshold && !alerted) {
        alerted = true;
        const details = result.checks.filter((c) => !c.ok).map((c) => c.name + ': ' + c.code + ' — ' + c.detail).join('\n');
        try {
          const sent = notifyFn ? await notifyFn('Arena Bridge не отвечает по публичному адресу после ' + failures + ' последовательных проверок.\n' + details) : null;
          if (sent && sent.ok === false) logWarn('monitor failure notification failed', { reason: sent.reason || sent.error });
        } catch (error) { logError('monitor failure notification failed', { error: String(error?.message || error) }); }
      }
      return result;
    } catch (error) {
      logError('remote monitor iteration failed', { error: String(error?.message || error) });
      return null;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(check, intervalMs);
  timer.unref?.();
  if (runImmediately) void check();

  return {
    check,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    status: () => ({ failures, alerted, running, stopped }),
  };
}
