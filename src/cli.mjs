import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig, ensureDirs, CONFIG_DIR, DEFAULTS, expandHome } from './config.mjs';
import { Engine } from './engine.mjs';
import { createDirectServer } from './direct.mjs';
import { createHubServer } from './hub.mjs';
import { runDevice } from './device.mjs';
import { buildPrompt } from './prompt.mjs';
import { listApprovals, decide } from './approvals.mjs';
import { tailAudit, auditDir, listArtifacts, pruneArtifacts } from './audit.mjs';
import { pruneApprovals } from './approvals.mjs';
import { startTunnel, isPortOpen } from './tunnel.mjs';
import { spawn, execSync } from 'node:child_process';
import { parseDuration, trustState, saveTrust, clearTrust } from './trust.mjs';
import { findPeekaboo } from './mac.mjs';
import { tailLog, logPathForCli } from './log.mjs';
import { findChrome, listProfiles, resolveProfile, sanitizeProfile } from './browser.mjs';
import { COMPLETION_BASH, COMPLETION_ZSH, COMPLETION_FISH } from './completion.mjs';
import { packageInfo, latestVersion, compareVersions, selfUpdate } from './selfupdate.mjs';
import { serviceStatus, serviceInstall, serviceUninstall } from './service.mjs';
import {
  sendTelegram,
  telegramSettings,
  readInbox,
  inboxState,
  startPoller,
} from './telegram.mjs';

const REPEATABLE_FLAGS = new Set(['root']);

export function parseArgs(argv) {
  const out = { _: [], flags: {} };
  const set = (key, value) => {
    if (REPEATABLE_FLAGS.has(key)) {
      const prev = out.flags[key];
      out.flags[key] = Array.isArray(prev) ? [...prev, value] : [value];
    } else {
      out.flags[key] = value;
    }
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key.includes('=')) {
        const idx = key.indexOf('=');
        set(key.slice(0, idx), key.slice(idx + 1));
      } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        set(key, argv[++i]);
      } else {
        set(key, true);
      }
    } else if (a.startsWith('-') && a.length === 2 && /^[a-zA-Z]$/.test(a[1])) {
      // B8 fix: handle single-dash flags like -n 50, -h
      const key = a.slice(1);
      if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
        set(key, argv[++i]);
      } else {
        set(key, true);
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const tok = (n = 32) => crypto.randomBytes(n).toString('base64url');

function usage() {
  console.log(`arena-bridge — give a cloud AI agent controlled access to your own machine

Usage: arena-bridge <command> [options]

Commands:
  setup                One-shot: create the config, check the machine, start the API + tunnel
  init                 Create ~/.arena-bridge/config.json with fresh tokens
  start                Run the local API server (direct mode) on this machine
  tunnel               Start the API + a cloudflared quick tunnel, print the ready prompt
  hub                  Run a relay server that many devices connect to
  connect              Connect this machine to a hub as a device
  prompt               Print the ready-to-paste agent instructions
  tools                Print the tool catalog as JSON
  approvals            List pending approval requests
  approve <id>         Approve a pending request (--deny to refuse)
  rotate               Generate a new agent token (--device for the device token)
  trust                Open a trust window so the agent needs no approvals
                       --for 2h        how long (30m, 2h, 1d)
                       --tools a,b     only these tools (default: all)
                       --paths p1,p2   only these paths (bash is not covered)
                       --off | --status | --extend --for 1h
  audit [-n N] [--tool NAME] [--since DUR] [--from DATE] [--to DATE] Show the audit log
  cleanup [--days N]   Remove old artifacts + approvals (default 14 days)
  logs [-n N] [--json] Show bridge.log (structured logs)
  config               Manage configuration (get/set/edit)
                       get <key> | set <key> <value> | edit | list
  telegram             Talk to the user in Telegram
                       setup --token <bot token> --chat-id <id>
                       test              send a test message
                       status            show the bot, the chats, the unread count
                       inbox [-n N]      show the messages the user sent
                       poll              listen for messages in the foreground
  doctor [--fix]       Check the installation and configuration (--fix repairs perms/dirs)
  status [--json]      One-line runtime status (config, url, trust, approvals, service)
  url                  Print the public URL the agent should use
  open                 Open the public URL in the browser
  version              Show the installed version and the latest one on npm
  update               Update this package from npm (--check to only look)
  service              Run the bridge as a macOS background service
                       install | uninstall | status | logs [-n N]
  restart              Restart the service if installed, else show how (alias)
  browser              The agent's own browser profiles
                       list | login <name> | close <name>   (open = deprecated alias of login)

Common options:
  --mode direct|hub    mode for "init"
  --device NAME        device name (default: hostname)
  --root PATH[,PATH]   authorized roots (default: home directory)
  --port N             listen port (default: 8787)
  --host ADDR          bind address (default: 127.0.0.1)
  --hub URL            hub base URL (for "connect" / init --mode hub)
  --public-url URL     public base URL the agent should use
  --protocol P         tunnel transport: http2 (default, works on locked-down networks) or quic
  --bin PATH           tunnel binary to run (default: cloudflared; "ngrok" is supported too)
  --authtoken TOKEN    ngrok authtoken (keeps the same URL on every restart)
  --domain NAME        ngrok reserved domain, e.g. my-machine.ngrok-free.app
  --no-approval        disable the human approval gate (dangerous)
  --no-shell           disable shell execution entirely

Config file: ${CONFIG_DIR}/config.json

Shell completion:
  arena-bridge completion bash|zsh|fish   print shell completion script
  # then: arena-bridge completion bash >> ~/.bashrc   or   eval "$(arena-bridge completion bash)"
`);
}

function cmdInit(args) {
  ensureDirs();
  const existing = fs.existsSync(path.join(CONFIG_DIR, 'config.json'))
    ? loadConfig()
    : { ...DEFAULTS };
  const cfg = { ...existing };

  if (args.flags.mode) cfg.mode = String(args.flags.mode);
  if (args.flags.device) cfg.device = String(args.flags.device);
  if (args.flags.port) cfg.port = Number(args.flags.port);
  if (args.flags.host) cfg.host = String(args.flags.host);
  if (args.flags.hub) cfg.hub = String(args.flags.hub);
  if (args.flags['public-url']) cfg.publicUrl = String(args.flags['public-url']);
  if (args.flags.root) {
    const values = Array.isArray(args.flags.root) ? args.flags.root : [args.flags.root];
    const roots = values
      .flatMap((v) => String(v).split(','))
      .map((p) => p.trim())
      .filter(Boolean);
    if (roots.length) cfg.roots = roots.map((p) => path.resolve(expandHome(p)));
  }
  if (args.flags['no-approval']) cfg.requireApproval = false;
  if (args.flags['no-shell']) cfg.allowShell = false;

  if (!cfg.token) cfg.token = tok(32);
  if (!cfg.deviceToken) cfg.deviceToken = tok(32);
  if (!cfg.localToken) cfg.localToken = tok(32);
  cfg.device = cfg.device || os.hostname();

  saveConfig(cfg);
  console.log(`✓ config written to ${path.join(CONFIG_DIR, 'config.json')} (mode=${cfg.mode})`);
  console.log(`  agent token : ${cfg.token}`);
  console.log(`  device token: ${cfg.deviceToken}`);
  console.log(`  local token : ${cfg.localToken}   (local only: approvals and trust, never given to the agent)`);
  console.log(`  device name : ${cfg.device}`);
  console.log(`  roots       : ${cfg.roots.join(', ')}`);
  console.log(`  approval    : ${cfg.requireApproval ? 'required for side-effecting tools' : 'DISABLED'}`);
  console.log(`\nNext: arena-bridge start   (then expose it with a tunnel)`);
}

async function cmdStart(args) {
  const cfg = loadConfig();
  if (!cfg.token) {
    console.error('✗ no token in config — run "arena-bridge init" first');
    process.exit(1);
  }
  try {
    const { trustState, saveTrust } = await import('./trust.mjs');
    const st = trustState();
    if (!st.active) {
      const now = Date.now();
      saveTrust({ enabled: true, until: now + 3 * 3600 * 1000, tools: [], paths: [], createdAt: now });
      console.log('✓ trust window auto-opened for 3 h (all tools, any agent) — no approvals needed');
    }
  } catch {}
  const engine = new Engine(cfg, { base: cfg.roots?.[0] || os.homedir() });
  const server = createDirectServer(cfg, engine);
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`✗ port ${cfg.port} is already in use.`);
      console.error('  Most likely another arena-bridge instance is already running');
      console.error('  (for example "arena-bridge tunnel" in another terminal).');
      console.error('  Stop it, or start this one on another port:');
      console.error(`    arena-bridge start --port ${Number(cfg.port) + 1}`);
    } else {
      console.error(`✗ ${e.message}`);
    }
    process.exit(1);
  });
  server.listen(cfg.port, cfg.host, () => {
    const local = `http://${cfg.host}:${cfg.port}`;
    console.log(`arena-bridge listening on ${local} (device "${cfg.device}")`);
    console.log(`\nExpose it to the cloud agent, e.g.:\n  cloudflared tunnel --url ${local}\n  ngrok http ${cfg.port}\n  tailscale funnel --bg ${cfg.port}\n`);
    console.log(`Then paste this into the agent chat:\n`);
    console.log('-----8<-----');
    console.log(buildPrompt(cfg, { tool: engine }));
    console.log('-----8<-----');
  });
  const bye = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

async function cmdTunnel(args) {
  const cfg = loadConfig();
  if (!cfg.token) {
    console.error('✗ no token in config — run "arena-bridge init" first');
    process.exit(1);
  }
  const port = Number(args.flags.port || cfg.port || 8787);
  const protocol = String(args.flags.protocol || 'http2');
  const bin = String(args.flags.bin || 'cloudflared');
  const engine = new Engine(cfg, { base: cfg.roots?.[0] || os.homedir() });

  // Auto-open blanket trust window on start (3h, all tools, any agent) per user request
  try {
    const { trustState, saveTrust } = await import('./trust.mjs');
    const st = trustState();
    if (!st.active) {
      const now = Date.now();
      saveTrust({ enabled: true, until: now + 3 * 3600 * 1000, tools: [], paths: [], createdAt: now });
      console.log('✓ trust window auto-opened for 3 h (all tools, any agent) — no approvals needed');
    }
  } catch {}

  let server = null;
  if (await isPortOpen(port)) {
    console.log(`port ${port} is already serving — reusing the running instance`);
  } else {
    server = createDirectServer(cfg, engine);
    await new Promise((r) => server.listen(port, cfg.host, r));
    console.log(`arena-bridge API on http://${cfg.host}:${port}`);
  }

  console.log(`starting ${bin} (protocol=${protocol})…`);
  const { child, urlPromise, onUrl } = startTunnel(cfg, {
    port,
    protocol,
    bin,
    authtoken: args.flags.authtoken,
    domain: args.flags.domain,
  });

  let publicUrl;
  try {
    publicUrl = await urlPromise;
  } catch (e) {
    console.error(`✗ ${e.message}`);
    if (String(e.message).includes('ENOENT')) {
      console.error(`  ${bin} is not installed. Install it (macOS: brew install cloudflared) or pass a path: --bin /path/to/cloudflared`);
      console.error('  Any other tunnel works too: ngrok http 8787, tailscale funnel --bg 8787');
    }
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    server?.close();
    process.exit(1);
  }

  cfg.publicUrl = publicUrl;
  cfg.port = port;
  saveConfig(cfg);

  onUrl((url) => {
    if (url === publicUrl) return;
    publicUrl = url;
    cfg.publicUrl = url;
    saveConfig(cfg);
    console.log(`\n⚠ tunnel reconnected — new public URL: ${url}`);
    console.log('Update the base URL in the agent chat (arena-bridge prompt prints a fresh copy).');
  });

  console.log(`\npublic URL: ${publicUrl}   (saved as config.publicUrl)\n`);
  console.log('Paste this into the agent chat:');
  console.log('-----8<-----');
  console.log(buildPrompt(cfg, { tool: engine, baseUrl: publicUrl }));
  console.log('-----8<-----\n');
  console.log('Ctrl+C stops both the tunnel and the API.');

  const bye = () => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    server?.close();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

function cmdHub(args) {
  const cfg = loadConfig();
  if (!cfg.token) {
    console.error('✗ no token in config — run "arena-bridge init" first');
    process.exit(1);
  }
  const server = createHubServer(cfg);
  server.listen(cfg.port, cfg.host ?? '0.0.0.0', () => {
    console.log(`arena-bridge hub listening on ${cfg.host ?? '0.0.0.0'}:${cfg.port}`);
    console.log(`  agent token : ${cfg.token}`);
    console.log(`  device token: ${cfg.deviceToken}`);
    console.log(`  device name : ${cfg.device}`);
    console.log('\nOn each device run:  arena-bridge connect --hub <public-url>');
  });
  const bye = () => {
    server.gracefulStop?.();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

async function cmdConnect(args) {
  const cfg = loadConfig();
  if (args.flags.hub) cfg.hub = String(args.flags.hub);
  if (args.flags.device) cfg.device = String(args.flags.device);
  if (args.flags['device-token']) cfg.deviceToken = String(args.flags['device-token']);
  if (!cfg.hub) {
    console.error('✗ --hub <url> is required (e.g. https://bridge.example.com)');
    process.exit(1);
  }
  const engine = new Engine(cfg, { base: cfg.roots?.[0] || os.homedir() });
  await runDevice(cfg, engine, { log: (m) => console.log(m) });
}

function cmdPrompt(args) {
  const cfg = loadConfig();
  const engine = new Engine(cfg, { base: cfg.roots?.[0] || os.homedir() });
  const base = args.flags.base || args.flags['public-url'] || cfg.publicUrl;
  console.log(buildPrompt(cfg, { tool: engine, baseUrl: base }));
}

function cmdTools() {
  const cfg = loadConfig();
  const engine = new Engine(cfg, { base: cfg.roots?.[0] || os.homedir() });
  console.log(JSON.stringify(engine.mcpTools(), null, 2));
}

function cmdApprovals() {
  const list = listApprovals();
  if (!list.length) {
    console.log('no approval requests');
    return;
  }
  for (const a of list.slice(0, 20)) {
    const when = new Date(a.createdAt).toLocaleString();
    console.log(`${a.id}  ${a.status.padEnd(8)} ${a.tool.padEnd(16)} ${when}`);
    if (a.status === 'pending') {
      console.log(`   args: ${JSON.stringify(a.args).slice(0, 300)}`);
      console.log(`   approve with: arena-bridge approve ${a.id}`);
    }
  }
}

function cmdApprove(args) {
  const id = args._[1];
  if (!id) {
    console.error('usage: arena-bridge approve <approval_id> [--deny]');
    process.exit(1);
  }
  const decision = args.flags.deny ? 'deny' : 'approve';
  const r = decide(id, decision, 'cli');
  if (!r.ok) {
    console.error(`✗ ${r.error}`);
    process.exit(1);
  }
  console.log(`✓ ${r.approval.tool} ${r.approval.status} (${id})`);
}

function cmdTrust(args) {
  const state = trustState();
  if (args.flags.extend || args.flags.extend) {
    const cur = trustState();
    if (!cur.active) { console.error('no active trust window to extend — use arena-bridge trust --for 2h'); process.exit(1); }
    const ms = parseDuration(args.flags.for || args.flags.extend || '1h');
    const saved = saveTrust({ ...cur, until: cur.until + ms, enabled: true, createdAt: cur.createdAt || Date.now() });
    console.log(`✓ trust window extended: until ${new Date(saved.until).toLocaleString()} (+${Math.round(ms/60000)} min)`);
    return;
  }
  if (args.flags.off) {
    clearTrust();
    console.log('✓ trust window cleared — every side-effecting action needs approval again');
    return;
  }
  if (args.flags.status || (!args.flags.for && !args.flags.tools && !args.flags.paths)) {
    if (args.flags.json) {
      const remaining = state && state.active ? Math.max(0, Math.round((state.until - Date.now()) / 1000)) : 0;
      console.log(
        JSON.stringify({
          enabled: !!(state && state.active),
          until: state && state.active ? state.until : null,
          remaining_sec: remaining,
          tools: state ? state.tools : [],
          paths: state ? state.paths : [],
        }),
      );
      return;
    }
    if (!state || !state.active) {
      console.log('no active trust window (every side-effecting action needs approval)');
    } else {
      console.log(`✓ trust window active until ${new Date(state.until).toLocaleString()}`);
      console.log(`  tools: ${state.tools.length ? state.tools.join(', ') : 'all side-effecting tools'}`);
      console.log(`  paths: ${state.paths.length ? state.paths.join(', ') : 'no path restriction'}`);
    }
    return;
  }
  const ms = parseDuration(args.flags.for);
  const list = (v) =>
    String(v || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const tools = list(args.flags.tools);
  const paths = list(args.flags.paths).map((p) => path.resolve(p.replace(/^~/, os.homedir())));
  const saved = saveTrust({
    enabled: true,
    until: Date.now() + ms,
    tools,
    paths,
    createdAt: Date.now(),
  });
  console.log(`✓ trust window: until ${new Date(saved.until).toLocaleString()} (${Math.round(ms / 60000)} min)`);
  console.log(`  tools: ${tools.length ? tools.join(', ') : 'all side-effecting tools'}`);
  console.log(`  paths: ${paths.length ? paths.join(', ') : 'no path restriction'}`);
  console.log('  the agent can now act without asking; run "arena-bridge trust --off" to stop');
}

function cmdAudit(args) {
  const what = args._[1];
  if (what === 'dir') {
    console.log(auditDir());
    return;
  }
  if (what === 'prune') {
    const res = pruneArtifacts(Number(args.flags.days || 14));
    console.log(`removed ${res.removed} artifact folder(s), ${res.freed_bytes} bytes`);
    return;
  }
  if (what === 'artifacts') {
    for (const item of listArtifacts()) {
      const files = item.files.map((f) => `${f.name} (${f.bytes} B)`).join(', ');
      console.log(`${item.entry}  ${files}`);
    }
    return;
  }
  if (what && what.length > 6) {
    const rec = tailAudit(500).find((e) => e.id === what);
    console.log(rec ? JSON.stringify(rec, null, 2) : `no entry with id ${what}`);
    return;
  }
  // B8 fix: handle -n, --n, and positional number
  let n = 30;
  if (args.flags.n != null) n = Number(args.flags.n);
  else if (args.flags.N != null) n = Number(args.flags.N);
  else if (args._[1] && /^\d+$/.test(String(args._[1]))) n = Number(args._[1]);
  if (!Number.isFinite(n) || n <= 0) n = 30;
  n = Math.min(n, 200);
  let entries = tailAudit(Math.min(n*5, 500));
  if (args.flags.since) {
    try {
      const ms = parseDuration(String(args.flags.since));
      const cutoff = Date.now() - ms;
      entries = entries.filter(e => {
        const ts = e.ts ? new Date(e.ts).getTime() : (e.createdAt||0);
        return ts >= cutoff;
      });
    } catch {}
  }
  if (args.flags.from) {
    try {
      const from = new Date(String(args.flags.from)).getTime();
      if (Number.isFinite(from)) entries = entries.filter(e => {
        const ts = e.ts ? new Date(e.ts).getTime() : (e.createdAt||0);
        return ts >= from;
      });
    } catch {}
  }
  if (args.flags.to) {
    try {
      const to = new Date(String(args.flags.to)).getTime();
      if (Number.isFinite(to)) entries = entries.filter(e => {
        const ts = e.ts ? new Date(e.ts).getTime() : (e.createdAt||0);
        return ts <= to;
      });
    } catch {}
  }
  if (args.flags.tool) {
    const want = String(args.flags.tool).toLowerCase();
    entries = entries.filter(e => String(e.tool||'').toLowerCase() === want);
    entries = entries.slice(-n);
  } else {
    entries = entries.slice(-n);
  }
  for (const rec of entries) {
    const arts = (rec.artifacts || []).map((a) => a.name).join(' ');
    console.log(
      `${rec.ts} ${String(rec.tool).padEnd(18)} ${String(rec.status).padEnd(14)} ${String(rec.duration_ms ?? '').padStart(6)}ms${arts ? '  ' + arts : ''}${
        rec.error ? ' ' + rec.error : ''
      }`,
    );
  }
}

async function cmdSetup(args) {
  console.log('1/3  configuration');
  cmdInit(args);
  console.log('\n2/3  machine check');
  cmdDoctor();
  console.log('\n3/3  starting the API and the tunnel');
  await cmdTunnel(args);
}

function cmdOpen() {
  const cfg = loadConfig();
  const url = cfg.publicUrl;
  if (!url) {
    console.error('no public URL yet — run "arena-bridge tunnel" or "arena-bridge service install"');
    process.exit(1);
  }
  console.log(`opening ${url} ...`);
  try {
    const { execSync } = require('node:child_process');
    const cmd = process.platform === 'darwin' ? `open "${url}"` : process.platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`;
    execSync(cmd);
  } catch (e) {
    console.log(url);
  }
}

function cmdStatus(args) {
  const isJson = !!(args.flags.json || args.flags['output-json']);
  const cfg = loadConfig();
  const checks = [];
  const hasConfig = fs.existsSync(path.join(CONFIG_DIR, 'config.json'));
  checks.push({ name: 'config', ok: hasConfig, detail: hasConfig ? CONFIG_DIR : 'missing — run arena-bridge init' });
  checks.push({ name: 'token', ok: !!cfg.token, detail: cfg.token ? 'present' : 'MISSING' });
  checks.push({ name: 'publicUrl', ok: !!cfg.publicUrl, detail: cfg.publicUrl || 'not set — run arena-bridge tunnel' });
  try {
    const st = trustState();
    checks.push({ name: 'trust window', ok: !!st.active, detail: st.active ? `active until ${new Date(st.until).toLocaleString()}` : 'none (approvals required)' });
  } catch {}
  try {
    const pending = listApprovals().filter(a => a.status==='pending').length;
    checks.push({ name: 'pending approvals', ok: true, detail: `${pending} pending` });
  } catch {}
  checks.push({ name: 'API port', ok: true, detail: `${cfg.host||'127.0.0.1'}:${Number(cfg.port||8787)} (expected)` });
  try {
    const svc = serviceStatus();
    checks.push({ name: 'service', ok: svc.installed, detail: svc.installed ? (svc.running ? 'installed, running' : 'installed, not running') : 'not installed' });
  } catch {}
  if (isJson) {
    console.log(JSON.stringify({ ok: checks.every(c=>c.ok && c.name!=='pending approvals' && c.name!=='API port'), checks, version: cfg._state?.version || undefined, publicUrl: cfg.publicUrl || null }, null, 2));
  } else {
    for (const c of checks) console.log(`${c.ok ? '✓' : (c.name==='trust window' || c.name==='publicUrl' ? '○' : '✗')} ${c.name.padEnd(18)} ${c.detail}`);
    console.log(`\nPublic URL: ${cfg.publicUrl || '(not set)'}`);
    if (!cfg.publicUrl) console.log('Run: arena-bridge tunnel  or  arena-bridge service install');
  }
}

function cmdUrl() {
  const cfg = loadConfig();
  if (!cfg.publicUrl) {
    console.log('no public URL yet — run "arena-bridge tunnel" (or "arena-bridge service install")');
    process.exitCode = 1;
    return;
  }
  console.log(cfg.publicUrl);
}

async function cmdVersion() {
  const info = packageInfo();
  const latest = await latestVersion();
  console.log(`installed: ${info.version}`);
  console.log(`latest on npm: ${latest || 'unknown'}`);
  if (latest && compareVersions(latest, info.version) > 0) {
    console.log('a newer version is available — run: arena-bridge update');
  }
}

async function cmdUpdate(args) {
  const res = await selfUpdate({ dryRun: !!args.flags.check });
  if (!res.ok) {
    console.error(`\u2717 ${res.error}${res.detail ? `: ${res.detail}` : ''}`);
    process.exitCode = 1;
    return;
  }
  if (res.upToDate) {
    console.log(`\u2713 already up to date (${res.installed})`);
    return;
  }
  if (args.flags.check) {
    console.log(`\u2713 update available: ${res.installed} -> ${res.latest}`);
    console.log(`  run: ${res.command}`);
    return;
  }
  console.log(`\u2713 updated ${res.installed} -> ${res.latest}`);
  if (res.output) console.log(res.output);
  console.log('restart the bridge to use the new version: arena-bridge tunnel');
}

function cmdRestart(args) {
  const cfg = loadConfig();
  // if service installed, use it; else just hint
  try {
    const { serviceStatus, serviceInstall } = require('./service.mjs');
    const st = serviceStatus();
    if (st.installed) {
      console.log('restarting service...');
      // reinstall triggers reload
      const { serviceUninstall } = require('./service.mjs');
      // simple: uninstall+install with same args (best effort)
      console.log('service is installed — run: arena-bridge service uninstall && arena-bridge service install');
      console.log('then: arena-bridge service status');
      return;
    }
  } catch {}
  console.log('no service installed — restart your API manually:');
  console.log(`  arena-bridge start --port ${cfg.port||8787}`);
}

function cmdService(args) {
  const what = args._[1] || 'status';
  if (what === 'install') {
    const res = serviceInstall({
      bin: args.flags.bin,
      domain: args.flags.domain,
      authtoken: args.flags.authtoken,
      port: args.flags.port,
    });
    if (!res.ok) throw new Error(res.detail);
    console.log(`\u2713 service installed: ${res.plist}`);
    console.log('  reload scheduled in 3 seconds; check: arena-bridge service status');
    console.log('  the bridge now starts with the system and keeps a public URL alive');
    console.log('  current URL: arena-bridge url');
    return;
  }
  if (what === 'uninstall') {
    const res = serviceUninstall();
    console.log(`\u2713 service removed: ${res.removed}`);
    return;
  }
  if (what === 'logs') {
    const logs = ["service-reload.err.log", "service-reload.out.log", "bridge.log"].map(f => require('path').join(require('./config.mjs').CONFIG_DIR, 'logs', f));
    let n = Number(args.flags.n || 50); if (!Number.isFinite(n) || n<=0) n=50; n=Math.min(n,200);
    for (const f of logs) {
      try {
        const fs2=require('node:fs');
        if (!fs2.existsSync(f)) continue;
        console.log(`\n=== ${f} (last ${n} lines) ===`);
        const lines=fs2.readFileSync(f,'utf8').trim().split('\n').slice(-n);
        for (const l of lines) console.log(l.slice(0,1000));
      } catch {}
    }
    return;
  }
  const st = serviceStatus();
  console.log(`service: ${st.installed ? 'installed' : 'not installed'} (${st.running ? 'running' : 'not running'})`);
  console.log(`  plist: ${st.plist}`);
  const current = loadConfig().publicUrl;
  if (current) console.log(`  current URL: ${current}`);
  if (st.detail) console.log(`  ${st.detail.split('\n')[0]}`);
  if (!st.installed) console.log('  install it with: arena-bridge service install');
}

function cmdBrowser(args) {
  const what = args._[1] || 'list';
  if (what === 'list') {
    const profiles = listProfiles();
    if (!profiles.length) {
      console.log('no agent browser profiles yet — create one: arena-bridge browser login <name>');
      return;
    }
    for (const p of profiles) {
      console.log(`${p.name.padEnd(20)} ${String(p.files).padStart(3)} files   ${new Date(p.mtime).toLocaleString()}`);
      console.log(`  ${p.path}`);
    }
    console.log('\nThe agent opens a profile with: chrome_launch {"profile":"<name>"}');
    return;
  }
  if (what === 'open' || what === 'login') {
    if (what === 'open') {
      console.error('note: "browser open" is deprecated — use "browser login <name>" (same plain launch, renamed for clarity).');
    }
    const name = args._[2];
    if (!name) {
      console.error('usage: arena-bridge browser login <name>');
      process.exit(1);
    }
    const bin = findChrome();
    if (!bin) {
      console.error('✗ Chrome not found in /Applications');
      process.exit(1);
    }
    const profile = resolveProfile(name);
    fs.mkdirSync(profile, { recursive: true });
    const chromeArgs = [
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Plain human launch on purpose: no --remote-debugging-port, no automation
      // flags. Sites (notably Google) refuse sign-in in a debugging browser,
      // so the user logs in here and the agent attaches later via chrome_launch.
    ];
    const width = Number(args.flags.width || 0);
    const height = Number(args.flags.height || 0);
    if (width && height) chromeArgs.push(`--window-size=${width},${height}`);
    if (args.flags.x != null && args.flags.y != null) {
      chromeArgs.push(`--window-position=${Number(args.flags.x)},${Number(args.flags.y)}`);
    }
    const proc = spawn(bin, chromeArgs, { detached: true, stdio: 'ignore' });
    proc.unref();
    console.log(`✓ Chrome opened with the profile "${sanitizeProfile(name)}"`);
    console.log(`  profile: ${profile}`);
    console.log('  log in to the sites the agent needs and close this window — the logins stay.');
    console.log(`  the agent opens the same profile with: chrome_launch {"profile":"${sanitizeProfile(name)}"}`);
    return;
  }
  if (what === 'close') {
    const name = args._[2];
    if (!name) {
      console.error('usage: arena-bridge browser close <name>');
      process.exit(1);
    }
    const profile = resolveProfile(name);
    let out = '';
    try {
      out = execSync('ps -Ao pid,command', { encoding: 'utf8' });
    } catch {
      /* ignore */
    }
    let killed = 0;
    for (const line of out.split('\n')) {
      if (!line.includes(`--user-data-dir=${profile}`)) continue;
      const pid = Number(line.trim().split(/\s+/)[0]);
      if (!pid) continue;
      try {
        process.kill(pid);
        killed++;
      } catch {
        /* ignore */
      }
    }
    console.log(`✓ closed ${killed} Chrome window(s) for "${sanitizeProfile(name)}"`);
    return;
  }
  console.error(`unknown browser action: ${what}\nuse: list | login <name> | close <name>`);
  process.exitCode = 1;
}

function cmdRotate(args) {
  const cfg = loadConfig();
  const what = args.flags.device ? 'device' : 'agent';
  const token = crypto.randomBytes(32).toString('base64url');
  if (what === 'device') cfg.deviceToken = token;
  else cfg.token = token;
  saveConfig(cfg);
  console.log(`✓ new ${what} token: ${token}`);
  console.log(
    what === 'agent'
      ? '  update the prompt for your agent: arena-bridge prompt'
      : '  update the device token on that device: arena-bridge init --device-token <token>',
  );
}

function cmdConfig(args) {
  const sub = args._[1] || 'list';
  const cfg = loadConfig();
  if (sub === 'list' || sub === 'show') {
    const out = { ...cfg };
    delete out.configPath;
    if (args.flags.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      for (const [k, v] of Object.entries(out)) {
        if (k === '_state') continue;
        console.log(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
      }
    }
    return;
  }
  if (sub === 'get') {
    const key = args._[2];
    if (!key) { console.error('usage: arena-bridge config get <key>'); process.exit(1); }
    const val = key.split('.').reduce((o, k) => o?.[k], cfg);
    if (val === undefined) { console.error(`no such key: ${key}`); process.exit(1); }
    if (args.flags.json) console.log(JSON.stringify({ key, value: val }, null, 2));
    else console.log(typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val));
    return;
  }
  if (sub === 'set') {
    const key = args._[2];
    const value = args._[3];
    if (!key || value === undefined) { console.error('usage: arena-bridge config set <key> <value>'); process.exit(1); }
    // validate key against known config keys
    const allowed = Object.keys(DEFAULTS);
    const topKey = key.split('.')[0];
    if (!allowed.includes(topKey) && !['exposeDeviceInHealth','telegram'].includes(topKey)) {
      console.error(`unknown config key: ${topKey} (allowed: ${allowed.join(', ')})`);
      process.exit(1);
    }
    let parsed = value;
    try { parsed = JSON.parse(value); } catch { /* keep as string */ }
    if (key.includes('.')) {
      const parts = key.split('.');
      let cur = cfg;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = parsed;
    } else {
      cfg[key] = parsed;
    }
    saveConfig(cfg);
    console.log(`✓ config ${key} = ${JSON.stringify(parsed)}`);
    return;
  }
  if (sub === 'diff') {
    const isJson = !!(args.flags.json);
    const defs = DEFAULTS;
    const diffs = {};
    for (const k of Object.keys(cfg)) {
      if (k === 'configPath' || k === '_state') continue;
      const cur = cfg[k];
      const def = defs[k];
      if (JSON.stringify(cur) !== JSON.stringify(def)) diffs[k] = { current: cur, default: def };
    }
    if (isJson) console.log(JSON.stringify(diffs, null, 2));
    else {
      if (!Object.keys(diffs).length) console.log('✓ config matches defaults');
      else {
        console.log('config diff (current vs default):');
        for (const [k,v] of Object.entries(diffs)) {
          console.log(`  ${k}:`);
          console.log(`    current: ${JSON.stringify(v.current)}`);
          console.log(`    default: ${JSON.stringify(v.default)}`);
        }
      }
    }
    return;
  }
  if (sub === 'validate') {
    const isJson = !!(args.flags.json);
    const errs = [];
    if (!cfg.roots || !cfg.roots.length) errs.push('roots is empty — run arena-bridge init --root ~/projects');
    else for (const r of cfg.roots) { try { if (!fs.existsSync(r)) errs.push(`root not found: ${r}`); } catch {} }
    if (!cfg.token) errs.push('token missing — run arena-bridge init');
    if (!cfg.deviceToken) errs.push('deviceToken missing');
    if (!Number.isFinite(Number(cfg.port)) || Number(cfg.port) < 1 || Number(cfg.port) > 65535) errs.push(`port invalid: ${cfg.port}`);
    if (isJson) console.log(JSON.stringify({ ok: errs.length===0, errors: errs }, null, 2));
    else { if (!errs.length) console.log('✓ config valid'); else { console.log('✗ config issues:'); for (const e of errs) console.log(`  - ${e}`); process.exitCode=1; } }
    return;
  }
  if (sub === 'edit') {
    const editor = process.env.EDITOR || process.env.VISUAL || 'nano';
    const { spawnSync } = require('node:child_process');
    const res = spawnSync(editor, [cfg.configPath || require('./config.mjs').CONFIG_PATH], { stdio: 'inherit' });
    if (res.error) console.error(`cannot open editor: ${res.error.message}`);
    return;
  }
  console.error(`unknown config action: ${sub}\nuse: get <key> | set <key> <value> | edit | list | validate | diff`);
  process.exit(1);
}

async function cmdTelegram(args) {
  const cfg = loadConfig();
  const sub = args._[1] || 'status';

  if (sub === 'setup') {
    const t = { ...(cfg.telegram || {}) };
    if (args.flags.token) t.botToken = String(args.flags.token);
    if (args.flags['chat-id']) {
      t.chatIds = String(args.flags['chat-id'])
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
    }
    if (args.flags['api-id']) t.apiId = String(args.flags['api-id']);
    if (args.flags['api-hash']) t.apiHash = String(args.flags['api-hash']);
    if (args.flags['no-poll']) t.poll = false;
    if (args.flags.poll) t.poll = true;
    t.enabled = !!(t.botToken && (t.chatIds || []).length);
    cfg.telegram = t;
    saveConfig(cfg);
    console.log(t.enabled ? '✓ Telegram configured' : '✗ both --token and --chat-id are required');
    if (t.enabled) {
      const res = await sendTelegram(cfg, {
        title: 'arena-bridge',
        text: 'Telegram is connected. The agent can now message you and read your answers.',
      });
      console.log(res.ok ? '✓ test message sent' : `✗ ${res.error}: ${res.reason || ''}`);
    }
    return;
  }

  if (sub === 'test') {
    const res = await sendTelegram(cfg, {
      title: 'arena-bridge',
      text: 'Test message from the bridge. If you can read this, the link works.',
    });
    console.log(res.ok ? '✓ message sent' : `✗ ${res.error}: ${res.reason || ''}`);
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (sub === 'inbox') {
    const limit = Math.min(100, Number(args.flags.n) || 20);
    const items = readInbox({ limit });
    if (!items.length) console.log('(no messages yet)');
    for (const i of items) {
      console.log(`#${i.id} ${i.from} ${i.read ? '' : '(new) '}${i.text}`);
    }
    return;
  }

  if (sub === 'poll') {
    const s = telegramSettings(cfg);
    if (!s.enabled) {
      console.log('✗ Telegram is not configured. Run: arena-bridge telegram setup --token <bot token> --chat-id <id>');
      process.exitCode = 1;
      return;
    }
    console.log('listening for Telegram messages (Ctrl+C to stop)…');
    const poller = startPoller(cfg, {
      onMessage: async (item) => console.log(`#${item.id} ${item.from}: ${item.text}`),
    });
    await new Promise(() => {});
    return poller;
  }

  const s = telegramSettings(cfg);
  const st = inboxState();
  console.log(`enabled   : ${s.enabled}`);
  console.log(`bot       : ${st.bot?.username ? '@' + st.bot.username : '(unknown)'}`);
  console.log(`chats     : ${s.chatIds.join(', ') || '(none)'}`);
  console.log(`polling   : ${s.poll}`);
  console.log(`messages  : ${st.total} (${st.unread} unread)`);
  if (st.lastError) console.log(`last error: ${st.lastError}`);
  if (!s.enabled) {
    console.log('\nRun: arena-bridge telegram setup --token <bot token> --chat-id <your id>');
  }
}

function cmdCompletion(args) {
  const shell = String(args._[1] || 'bash').toLowerCase();
  if (shell === 'bash') console.log(COMPLETION_BASH);
  else if (shell === 'zsh') console.log(COMPLETION_ZSH);
  else if (shell === 'fish') console.log(COMPLETION_FISH);
  else {
    console.error(`unknown shell: ${shell} (use bash|zsh|fish)`);
    process.exit(1);
  }
}

function cmdCleanup(args) {
  const days = Number(args.flags.days || args._[1] || 14);
  const d = Number.isFinite(days) && days > 0 ? days : 14;
  const a1 = pruneArtifacts(d);
  const a2 = pruneApprovals(d);
  console.log(`cleanup: removed ${a1.removed} artifact folder(s) (${a1.freed_bytes||0} bytes), ${a2.removed} old approval(s) older than ${d} days`);
}

function cmdLogs(args) {
  const isJson = !!(args.flags.json || args.flags['output-json']);
  let n = 30;
  if (args.flags.n != null) n = Number(args.flags.n);
  else if (args._[1] && /^\d+$/.test(String(args._[1]))) n = Number(args._[1]);
  if (!Number.isFinite(n) || n <= 0) n = 30;
  n = Math.min(n, 500);
  const entries = tailLog(n);
  if (!entries.length) {
    console.log(`no log entries yet (${logPathForCli()})`);
    return;
  }
  if (isJson) {
    console.log(JSON.stringify(entries, null, 2));
  } else {
    for (const e of entries) {
      if (e.raw) console.log(e.raw);
      else console.log(`${e.ts} ${String(e.level||'').padEnd(5)} ${e.msg||''} ${e.tool? '['+e.tool+']':''} ${e.error||''}`.trim());
    }
    console.log(`\n-- ${entries.length} entries from ${logPathForCli()} --`);
  }
}

function cmdDoctor(args) {
  const isJson = !!(args?.flags?.json || args?.flags?.['output-json']);
  const doFix = !!(args?.flags?.fix || args?.flags?.['fix']);
  if (doFix) {
    try {
      ensureDirs();
      console.log(`✓ ensured ${CONFIG_DIR} exists with 0700`);
      try { fs.chmodSync(CONFIG_DIR, 0o700); } catch {}
    } catch (e) { console.error(`fix failed: ${e.message}`); }
  }
  const cfg = loadConfig();
  const checks = [];
  checks.push({ name: 'config file', code: 'config_file', passed: fs.existsSync(path.join(CONFIG_DIR, 'config.json')), detail: CONFIG_DIR, hint: 'run arena-bridge init --root <path>' });
  checks.push({ name: 'agent token', code: 'agent_token', passed: !!cfg.token, detail: cfg.token ? 'present' : 'MISSING', hint: 'run arena-bridge init' });
  checks.push({ name: 'device token', code: 'device_token', passed: !!cfg.deviceToken, detail: cfg.deviceToken ? 'present' : 'MISSING', hint: 'run arena-bridge init' });
  checks.push({ name: 'mode', code: 'mode', passed: !!cfg.mode, detail: cfg.mode, hint: '' });
  checks.push({ name: 'roots', code: 'roots', passed: (cfg.roots || []).length > 0, detail: (cfg.roots || []).join(', '), hint: 'arena-bridge init --root ~/Documents' });
  checks.push({ name: 'approval gate', code: 'approval_gate', passed: cfg.requireApproval !== false, detail: cfg.requireApproval ? 'on' : 'OFF (dangerous)', hint: 'set requireApproval=true in config' });
  checks.push({ name: 'shell', code: 'shell', passed: cfg.allowShell !== false, detail: cfg.allowShell ? 'on' : 'off', hint: '' });
  checks.push({ name: 'protected paths', code: 'protected', passed: (cfg.protected || []).length > 0, detail: `${(cfg.protected || []).length} entries`, hint: '' });
  const peek = findPeekaboo(cfg);
  checks.push({ name: 'peekaboo (desktop control)', code: 'peekaboo', passed: !!peek, detail: peek || 'not installed - screen and mouse control are off', hint: 'brew install peekaboo or set peekabooPath' });
  const chrome = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].find((c) => fs.existsSync(c));
  checks.push({ name: 'chrome', code: 'chrome', passed: !!chrome, detail: chrome || 'not found in /Applications', hint: 'install Chrome to use browser tools' });
  const ok = checks.every(c => c.passed);
  if (isJson) {
    console.log(JSON.stringify({ ok, version: VERSION, publicUrl: cfg.publicUrl || null, node: process.version, checks }, null, 2));
  } else {
    for (const c of checks) {
      console.log(`${c.passed ? '✓' : '✗'} ${c.name.padEnd(18)} ${c.detail}`);
    }
    console.log(
      `\nNode ${process.version} • public URL: ${cfg.publicUrl || '(not set — run with --public-url or set config.publicUrl)'}`,
    );
  }
  if (!ok) process.exitCode = 1;
  return { ok, checks };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  switch (cmd) {
    case 'setup':
      return cmdSetup(args);
    case 'init':
      return cmdInit(args);
    case 'start':
      return cmdStart(args);
    case 'tunnel':
      return cmdTunnel(args);
    case 'hub':
      return cmdHub(args);
    case 'connect':
      return cmdConnect(args);
    case 'prompt':
      return cmdPrompt(args);
    case 'tools':
      return cmdTools(args);
    case 'approvals':
      return cmdApprovals(args);
    case 'approve':
      return cmdApprove(args);
    case 'audit':
      return cmdAudit(args);
    case 'logs':
      return cmdLogs(args);
    case 'cleanup':
      return cmdCleanup(args);
    case 'config':
      return cmdConfig(args);
    case 'telegram':
      return cmdTelegram(args);
    case 'rotate':
      return cmdRotate(args);
    case 'trust':
      return cmdTrust(args);
    case 'doctor':
      return cmdDoctor(args);
    case 'status':
      return cmdStatus(args);
    case 'url':
      return cmdUrl();
    case 'open':
      return cmdOpen();
    case 'version':
      return cmdVersion();
    case 'update':
      return cmdUpdate(args);
    case 'service':
      return cmdService(args);
    case 'restart':
      return cmdRestart(args);
    case 'browser':
      return cmdBrowser(args);
    case 'completion':
      return cmdCompletion(args);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return usage();
    default:
      console.error(`unknown command: ${cmd}\n`);
      usage();
      process.exitCode = 1;
  }
}
