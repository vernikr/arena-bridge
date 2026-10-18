import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR, ensureDirs } from './config.mjs';
import { APP_NAME, SERVICE_LABEL as LABEL } from './app.mjs';

export function plistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

/**
 * The launchd agent starts this script instead of the node binary, so the system settings
 * show the name of the app and not "node".
 */
export function runnerPath() {
  return path.join(CONFIG_DIR, APP_NAME);
}

/**
 * The node of the version manager lives in a folder that every new shell creates and that is
 * deleted afterwards. macOS binds a permission to the exact file, so a service that starts from
 * such a folder loses its screen recording permission. The service always uses the permanent
 * installation instead.
 */
export function stableNode() {
  const exec = process.execPath;
  if (!exec.includes('fnm_multishells')) return exec;
  const versions = path.join(os.homedir(), '.local', 'share', 'fnm', 'node-versions');
  try {
    const dirs = fs.readdirSync(versions)
      .map((d) => path.join(versions, d))
      .filter((d) => fs.existsSync(path.join(d, 'installation', 'bin', 'node')))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (dirs[0]) return path.join(dirs[0], 'installation', 'bin', 'node');
  } catch {
    /* keep the current one */
  }
  return exec;
}

/** The PATH of the service: permanent folders only. */
export function servicePath() {
  const parts = (process.env.PATH || '/usr/local/bin:/usr/bin:/bin')
    .split(':')
    .filter((p) => p && !p.includes('fnm_multishells'));
  const home = path.join(os.homedir(), '.local', 'bin');
  const nodeBin = path.dirname(stableNode());
  return [home, nodeBin, ...parts.filter((p) => p !== home && p !== nodeBin)].join(':');
}

export function logDir() {
  return path.join(CONFIG_DIR, 'logs');
}

function cliEntry() {
  // bin/arena-bridge.mjs lives next to src/
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', 'bin', 'arena-bridge.mjs');
}

function runnerScript() {
  return `#!/bin/sh
# ${APP_NAME}: the background service of the bridge.
exec "${stableNode()}" "${cliEntry()}" "$@"
`;
}

export function plistXml({ bin, domain, authtoken, port } = {}) {
  const logs = logDir();
  const extra = [];
  if (bin) extra.push('--bin', String(bin));
  if (domain) extra.push('--domain', String(domain));
  if (authtoken) extra.push('--authtoken', String(authtoken));
  if (port) extra.push('--port', String(port));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${runnerPath()}</string>
    <string>tunnel</string>
${extra.map((a) => `    <string>${a}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(logs, 'bridge.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(logs, 'bridge.err.log')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${servicePath()}</string>
  </dict>
</dict>
</plist>
`;
}

function launchctl(args, { quiet = false } = {}) {
  try {
    return execFileSync('launchctl', args, { encoding: 'utf8', stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'pipe' });
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
}

export function serviceStatus() {
  const installed = fs.existsSync(plistPath());
  const out = launchctl(['print', `gui/${process.getuid()}/${LABEL}`], { quiet: true });
  const running = /state = running/.test(out);
  return { installed, running, plist: plistPath(), detail: out.trim().slice(0, 600) };
}

export function serviceInstall(options = {}) {
  ensureDirs();
  fs.mkdirSync(logDir(), { recursive: true });
  const dir = path.dirname(plistPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(runnerPath(), runnerScript(), { mode: 0o755 });
  fs.chmodSync(runnerPath(), 0o755);
  fs.writeFileSync(plistPath(), plistXml(options));
  launchctl(['bootout', `gui/${process.getuid()}/${LABEL}`], { quiet: true });
  const out = launchctl(['bootstrap', `gui/${process.getuid()}`, plistPath()], { quiet: true });
  launchctl(['enable', `gui/${process.getuid()}/${LABEL}`], { quiet: true });
  return { ok: true, plist: plistPath(), detail: (out || '').trim().slice(0, 400) };
}

export function serviceUninstall() {
  launchctl(['bootout', `gui/${process.getuid()}/${LABEL}`], { quiet: true });
  const p = plistPath();
  if (fs.existsSync(p)) fs.rmSync(p);
  return { ok: true, removed: p };
}
