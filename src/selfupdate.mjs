import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PKG = 'arena-bridge';

export function packageInfo() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = require(path.join(here, '..', 'package.json'));
    return { name: pkg.name || PKG, version: pkg.version || '0.0.0', repository: pkg.repository?.url || null };
  } catch {
    return { name: PKG, version: '0.0.0', repository: null };
  }
}

export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

/** Latest published version on the npm registry, or null when the registry is unreachable. */
export async function latestVersion(timeoutMs = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://registry.npmjs.org/${PKG}/latest`, {
      signal: ctl.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.version || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function run(cmd, args, { timeout = 300000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: stdout || '', stderr: stderr || '', error: err?.message || null });
    });
  });
}

/** Install the newest published version of the package over the current global install. */
export async function selfUpdate({ dryRun = false } = {}) {
  const info = packageInfo();
  const latest = await latestVersion();
  if (!latest) {
    return { ok: false, error: 'the npm registry is not reachable from this machine' };
  }
  if (compareVersions(latest, info.version) <= 0) {
    return { ok: true, upToDate: true, installed: info.version, latest };
  }
  if (dryRun) {
    return { ok: true, upToDate: false, installed: info.version, latest, command: `npm i -g ${PKG}@latest` };
  }
  const res = await run('npm', ['i', '-g', `${PKG}@latest`]);
  if (!res.ok) {
    return {
      ok: false,
      error: 'npm install failed',
      detail: (res.stderr || res.stdout || res.error || '').trim().slice(0, 600),
      installed: info.version,
      latest,
    };
  }
  return {
    ok: true,
    updated: true,
    installed: info.version,
    latest,
    output: (res.stdout || res.stderr || '').trim().slice(0, 1200),
  };
}
