import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR, ensureDirs } from './config.mjs';
import { APP_NAME, SERVICE_LABEL as LABEL, AGENT_NAME } from './app.mjs';

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
 * The app bundle that holds the helper. It gives the screen and the accessibility
 * permissions to the app and not to the node binary.
 */
export function appBundlePath() {
  const explicit = process.env.ARENA_BRIDGE_APP;
  const candidates = explicit
    ? [explicit]
    : [
        path.join('/Applications', `${APP_NAME}.app`),
        path.join(os.homedir(), 'Applications', `${APP_NAME}.app`),
      ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(path.join(candidate, 'Contents', 'Info.plist'))) return candidate;
  }
  return null;
}

/**
 * The helper inside the bundle starts the bridge. macOS gives the permissions to the
 * app that starts the request, so the system settings show the name of the app.
 */
export function agentPath() {
  const bundle = appBundlePath();
  if (!bundle) return null;
  const helper = path.join(bundle, 'Contents', 'Helpers', AGENT_NAME);
  try {
    fs.accessSync(helper, fs.constants.X_OK);
    return fs.statSync(helper).isFile() ? helper : null;
  } catch { return null; }
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

/**
 * The command the service starts. The helper inside the app bundle gives the screen and the
 * accessibility permissions to the app, so the system settings show its name. Without the app
 * the service starts the wrapper script.
 */
export function programArguments({ bin, domain, authtoken, port } = {}) {
  const extra = [];
  if (bin) extra.push('--bin', String(bin));
  if (domain) extra.push('--domain', String(domain));
  if (authtoken) extra.push('--authtoken', String(authtoken));
  if (port) extra.push('--port', String(port));
  const helper = agentPath();
  if (helper) return [helper, stableNode(), cliEntry(), 'tunnel', ...extra];
  return [runnerPath(), 'tunnel', ...extra];
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function plistXml(options = {}) {
  const logs = logDir();
  const program = programArguments(options);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${program.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(path.join(logs, 'bridge.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logs, 'bridge.err.log'))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(servicePath())}</string>
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

export const reloadScript = "#!/bin/sh\nset -eu\nTARGET=$1\nPLIST=$2\nSTATUS=$3\nJOB=$4\nDOMAIN=${TARGET%/*}\nfinish() {\n  code=$?\n  trap - EXIT\n  if [ \"$code\" -eq 0 ]; then printf 'loaded\\n' > \"$STATUS\"; else printf 'failed (%s)\\n' \"$code\" > \"$STATUS\"; fi\n  rm -f \"$0\"\n  /bin/launchctl remove \"$JOB\" >/dev/null 2>&1 || true\n  exit \"$code\"\n}\ntrap finish EXIT\nprintf 'scheduled\\n' > \"$STATUS\"\nsleep 3\n/bin/launchctl enable \"$TARGET\"\nif /bin/launchctl print \"$TARGET\" >/dev/null 2>&1; then\n  /bin/launchctl bootout \"$TARGET\"\nfi\nattempt=0\nuntil /bin/launchctl bootstrap \"$DOMAIN\" \"$PLIST\"; do\n  attempt=$((attempt + 1))\n  [ \"$attempt\" -lt 10 ] || exit 1\n  sleep 1\ndone\n/bin/launchctl print \"$TARGET\" >/dev/null\n";

export function serviceInstall(options = {}) {
  ensureDirs();
  fs.mkdirSync(logDir(), { recursive: true });
  fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
  fs.writeFileSync(runnerPath(), runnerScript(), { mode: 0o755 });
  fs.chmodSync(runnerPath(), 0o755);
  const plist = plistPath();
  fs.writeFileSync(`${plist}.tmp`, plistXml(options), { mode: 0o600 });
  fs.renameSync(`${plist}.tmp`, plist);
  const job = `${LABEL}.reload.${randomUUID()}`;
  const script = path.join(CONFIG_DIR, `${job}.sh`);
  const status = path.join(CONFIG_DIR, 'service-reload.status');
  fs.writeFileSync(script, reloadScript, { mode: 0o700 });
  fs.writeFileSync(status, 'scheduled\n', { mode: 0o600 });
  try {
    execFileSync('launchctl', ['submit', '-l', job, '-o', path.join(logDir(), 'service-reload.log'),
      '-e', path.join(logDir(), 'service-reload.err.log'), '--', '/bin/sh', script,
      `gui/${process.getuid()}/${LABEL}`, plist, status, job], { encoding: 'utf8', timeout: 20000 });
  } catch (e) {
    fs.rmSync(script, { force: true });
    fs.writeFileSync(status, 'submission failed\n');
    return { ok: false, plist, detail: String(e.stderr || e.message).slice(0, 400) };
  }
  return { ok: true, scheduled: true, plist, status, detail: 'reload scheduled; check service status and service-reload.status' };
}

export function serviceUninstall() {
  launchctl(['bootout', `gui/${process.getuid()}/${LABEL}`], { quiet: true });
  const p = plistPath();
  if (fs.existsSync(p)) fs.rmSync(p);
  return { ok: true, removed: p };
}
