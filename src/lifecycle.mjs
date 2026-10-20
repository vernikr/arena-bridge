import { audit } from './audit.mjs';
import { VERSION } from './version.mjs';

/** Launchd jobs set XPC_SERVICE_NAME; anything else was started by hand. */
const origin = () => (process.env.XPC_SERVICE_NAME ? 'launchd' : 'cli');

export function bridgeEvent(status, { port, reason } = {}) {
  audit({ kind: 'service', tool: 'bridge', status, via: origin(), actor: 'system', source: { channel: 'local' }, pid: process.pid, version: VERSION, port, reason });
}

export function tunnelEvent(status, extra = {}) {
  audit({ kind: 'tunnel', tool: 'tunnel', status, via: origin(), actor: 'system', ...extra });
}
