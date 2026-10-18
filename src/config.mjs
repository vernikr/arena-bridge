import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const CONFIG_DIR =
  process.env.ARENA_BRIDGE_HOME || path.join(os.homedir(), '.arena-bridge');

export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
export const AUDIT_PATH = path.join(CONFIG_DIR, 'audit.log');
export const APPROVALS_DIR = path.join(CONFIG_DIR, 'approvals');

export const DEFAULTS = {
  mode: 'direct', // 'direct' = this machine serves the API | 'hub' = relay for many devices
  host: '127.0.0.1',
  port: 8787,
  publicUrl: null, // public base URL the cloud agent should use (e.g. https://x.trycloudflare.com)
  token: null, // agent token: the cloud agent authenticates with this
  deviceToken: null, // device token: only a device may use this
  hub: null, // hub base URL, when mode=hub
  device: os.hostname(), // this device's name
  roots: [os.homedir()], // directories the agent may touch
  protected: [
    '~/.arena-bridge',
    '~/.ssh',
    '~/.gnupg',
    '~/.aws',
    '~/.azure',
    '~/.kube',
    '~/.docker',
    '~/.config/gh',
    '~/.config/gcloud',
    '~/.npmrc',
    '~/.pypirc',
    '~/.netrc',
    '~/.git-credentials',
    '~/Library/Keychains',
    '~/Library/Application Support/Google/Chrome',
    '~/Library/Application Support/Firefox',
    '~/.mozilla',
  ],
  allowShell: true,
  requireApproval: true, // dangerous tools need a local human approval
  approvalWaitSec: 45, // how long the agent blocks waiting for a human
  approvalTtlSec: 900, // how long an approval request stays valid
  peekabooPath: null, // explicit path to the peekaboo binary (macOS desktop control)
  maxOutputBytes: 8 * 1024 * 1024,
  maxUploadBytes: 16 * 1024 * 1024,
  commandTimeoutSec: 120,
  audit: true,
  telegram: {
    enabled: false, // notify the user in Telegram
    botToken: null, // bot token from @BotFather
    chatIds: [], // chats the bridge may write to
    poll: true, // listen for incoming messages and approval commands
    apiId: null, // optional MTProto app id (not used by the bot)
    apiHash: null, // optional MTProto app hash (not used by the bot)
  },
};

export function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function ensureDirs() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(APPROVALS_DIR, { recursive: true, mode: 0o700 });
}

export function loadConfig() {
  let fileCfg = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      throw new Error(`Invalid config file ${CONFIG_PATH}: ${e.message}`);
    }
  }
  const cfg = { ...DEFAULTS, ...fileCfg };
  cfg.roots = (cfg.roots || []).map((p) => path.resolve(expandHome(String(p))));
  cfg.protected = (cfg.protected || []).map((p) => path.resolve(expandHome(String(p))));
  cfg.configPath = CONFIG_PATH;
  return cfg;
}

export function saveConfig(cfg) {
  ensureDirs();
  const out = { ...cfg };
  delete out.configPath;
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify(out, null, 2) + '\n',
    { mode: 0o600 },
  );
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}
