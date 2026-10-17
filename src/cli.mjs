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
import { tailAudit } from './audit.mjs';
import { startTunnel, isPortOpen } from './tunnel.mjs';
import { spawn, execSync } from 'node:child_process';
import { parseDuration, trustState, saveTrust, clearTrust } from './trust.mjs';
import { findPeekaboo } from './mac.mjs';
import { findChrome, listProfiles, resolveProfile, sanitizeProfile } from './browser.mjs';
import { packageInfo, latestVersion, compareVersions, selfUpdate } from './selfupdate.mjs';
import { serviceStatus, serviceInstall, serviceUninstall } from './service.mjs';

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
                       --off | --status
  audit [-n N]         Show the audit log
  doctor               Check the installation and configuration
  url                  Print the public URL the agent should use
  version              Show the installed version and the latest one on npm
  update               Update this package from npm (--check to only look)
  service              Run the bridge as a macOS background service
                       install | uninstall | status
  browser              The agent's own browser profiles
                       list | open <name> | close <name>

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

Config file: ${CONFIG_DIR}/config.json`);
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

function cmdStart(args) {
  const cfg = loadConfig();
  if (!cfg.token) {
    console.error('✗ no token in config — run "arena-bridge init" first');
    process.exit(1);
  }
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

  let server = null;
  if (await isPortOpen(port)) {
    console.log(`port ${port} is already serving — reusing the running instance`);
  } else {
    server = createDirectServer(cfg, engine);
    await new Promise((r) => server.listen(port, cfg.host, r));
    console.log(`arena-bridge API on http://${cfg.host}:${port}`);
  }

  console.log(`starting ${bin} (protocol=${protocol})…`);
  const { child, urlPromise } = startTunnel(cfg, {
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
  if (args.flags.off) {
    clearTrust();
    console.log('✓ trust window cleared — every side-effecting action needs approval again');
    return;
  }
  if (args.flags.status || (!args.flags.for && !args.flags.tools && !args.flags.paths)) {
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
  const n = Number(args.flags.n || 30);
  for (const rec of tailAudit(n)) {
    console.log(
      `${rec.ts} ${String(rec.tool).padEnd(18)} ${String(rec.status).padEnd(16)} ${rec.duration_ms ?? ''}${
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

function cmdService(args) {
  const what = args._[1] || 'status';
  if (what === 'install') {
    const res = serviceInstall();
    console.log(`\u2713 service installed: ${res.plist}`);
    console.log('  the bridge now starts with the system and keeps a public URL alive');
    console.log('  current URL: arena-bridge url');
    return;
  }
  if (what === 'uninstall') {
    const res = serviceUninstall();
    console.log(`\u2713 service removed: ${res.removed}`);
    return;
  }
  const st = serviceStatus();
  console.log(`service: ${st.installed ? 'installed' : 'not installed'} (${st.running ? 'running' : 'not running'})`);
  console.log(`  plist: ${st.plist}`);
  if (st.detail) console.log(`  ${st.detail.split('\n')[0]}`);
  if (!st.installed) console.log('  install it with: arena-bridge service install');
}

function cmdBrowser(args) {
  const what = args._[1] || 'list';
  if (what === 'list') {
    const profiles = listProfiles();
    if (!profiles.length) {
      console.log('no agent browser profiles yet — create one: arena-bridge browser open <name>');
      return;
    }
    for (const p of profiles) {
      console.log(`${p.name.padEnd(20)} ${String(p.files).padStart(3)} files   ${new Date(p.mtime).toLocaleString()}`);
      console.log(`  ${p.path}`);
    }
    console.log('\nThe agent opens a profile with: chrome_launch {"profile":"<name>"}');
    return;
  }
  if (what === 'open') {
    const name = args._[2];
    if (!name) {
      console.error('usage: arena-bridge browser open <name>');
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
      '--remote-debugging-port=0',
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
  console.error(`unknown browser action: ${what}\nuse: list | open <name> | close <name>`);
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

function cmdDoctor() {
  const cfg = loadConfig();
  const checks = [];
  checks.push(['config file', fs.existsSync(path.join(CONFIG_DIR, 'config.json')), CONFIG_DIR]);
  checks.push(['agent token', !!cfg.token, cfg.token ? 'present' : 'MISSING — run init']);
  checks.push(['device token', !!cfg.deviceToken, cfg.deviceToken ? 'present' : 'MISSING — run init']);
  checks.push(['mode', !!cfg.mode, cfg.mode]);
  checks.push(['roots', (cfg.roots || []).length > 0, (cfg.roots || []).join(', ')]);
  checks.push(['approval gate', cfg.requireApproval !== false, cfg.requireApproval ? 'on' : 'OFF (dangerous)']);
  checks.push(['shell', cfg.allowShell !== false, cfg.allowShell ? 'on' : 'off']);
  checks.push(['protected paths', (cfg.protected || []).length > 0, `${(cfg.protected || []).length} entries`]);
  const peek = findPeekaboo(cfg);
  checks.push(['peekaboo (desktop control)', !!peek, peek || 'not installed - screen and mouse control are off']);
  const chrome = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].find((c) => fs.existsSync(c));
  checks.push(['chrome', !!chrome, chrome || 'not found in /Applications']);
  let ok = true;
  for (const [name, passed, detail] of checks) {
    if (!passed) ok = false;
    console.log(`${passed ? '✓' : '✗'} ${name.padEnd(18)} ${detail}`);
  }
  console.log(
    `\nNode ${process.version} • public URL: ${cfg.publicUrl || '(not set — run with --public-url or set config.publicUrl)'}`,
  );
  if (!ok) process.exitCode = 1;
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
    case 'rotate':
      return cmdRotate(args);
    case 'trust':
      return cmdTrust(args);
    case 'doctor':
      return cmdDoctor(args);
    case 'url':
      return cmdUrl();
    case 'version':
      return cmdVersion();
    case 'update':
      return cmdUpdate(args);
    case 'service':
      return cmdService(args);
    case 'browser':
      return cmdBrowser(args);
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
