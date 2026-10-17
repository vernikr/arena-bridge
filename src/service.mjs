import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR, ensureDirs } from './config.mjs';

const LABEL = 'ai.arena.bridge';

export function plistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

export function logDir() {
  return path.join(CONFIG_DIR, 'logs');
}

function cliEntry() {
  // bin/arena-bridge.mjs lives next to src/
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', 'bin', 'arena-bridge.mjs');
}

function plistXml() {
  const cli = cliEntry();
  const logs = logDir();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${cli}</string>
    <string>tunnel</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(logs, 'bridge.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(logs, 'bridge.err.log')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}</string>
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

export function serviceInstall() {
  ensureDirs();
  fs.mkdirSync(logDir(), { recursive: true });
  const dir = path.dirname(plistPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(plistPath(), plistXml());
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
