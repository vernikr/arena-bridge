import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { checkPath } from './policy.mjs';

const PEEKABOO_CANDIDATES = [
  '/usr/local/bin/peekaboo',
  '/opt/homebrew/bin/peekaboo',
  '/opt/local/bin/peekaboo',
  '/Applications/Peekaboo.app/Contents/MacOS/peekaboo',
  path.join(os.homedir(), '.local/bin/peekaboo'),
  path.join(os.homedir(), '.peekaboo/bin/peekaboo'),
  path.join(os.homedir(), 'bin/peekaboo'),
];

const NOT_FOUND_HINT =
  'peekaboo is not installed on this machine. Install it (macOS: brew install peekaboo, or download the release from https://github.com/openclaw/Peekaboo) and make sure the binary is on PATH.';

export function findPeekaboo(cfg = {}) {
  const explicit = cfg.peekabooPath || process.env.PEEKABOO_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  for (const c of PEEKABOO_CANDIDATES) if (fs.existsSync(c)) return c;
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d, 'peekaboo');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function run(bin, args, { timeout = 60, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ stdout: '', stderr: String(e.message), exit_code: -1 });
      return;
    }
    const out = [];
    const err = [];
    let outLen = 0;
    let errLen = 0;
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, Math.max(1, timeout) * 1000);
    child.stdout.on('data', (c) => {
      if (outLen > 4 * 1024 * 1024) return;
      out.push(c);
      outLen += c.length;
    });
    child.stderr.on('data', (c) => {
      if (errLen > 256 * 1024) return;
      err.push(c);
      errLen += c.length;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ stdout: '', stderr: String(e.message), exit_code: -1 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        exit_code: code ?? -1,
      });
    });
  });
}

const UNKNOWN = /unknown command|unrecognized command|invalid command|no such command|unknown subcommand|usage:/i;

async function runVariants(bin, variants, opts) {
  let last = null;
  for (const args of variants) {
    const res = await run(bin, args, opts);
    last = { ...res, args };
    if (res.exit_code === 0) return last;
    if (!UNKNOWN.test(res.stderr || '')) return last;
  }
  return last;
}

function parseJson(text) {
  if (!text) return null;
  const t = text.trim();
  const start = t.search(/[[{]/);
  if (start < 0) return null;
  try {
    return JSON.parse(t.slice(start));
  } catch {
    return null;
  }
}

function collectElements(node, out = [], depth = 0) {
  if (!node || depth > 6) return out;
  if (Array.isArray(node)) {
    for (const n of node) collectElements(n, out, depth + 1);
    return out;
  }
  if (typeof node !== 'object') return out;
  if (node.elements && Array.isArray(node.elements)) {
    for (const e of node.elements) {
      out.push({
        id: e.id ?? e.elementId ?? e.element_id ?? null,
        role: e.role ?? e.elementRole ?? e.type ?? null,
        title: e.title ?? e.label ?? e.name ?? e.placeholder ?? null,
        value: typeof e.value === 'string' ? e.value.slice(0, 200) : null,
        bounds: e.frame ?? e.bounds ?? e.rect ?? null,
        enabled: e.enabled ?? null,
      });
    }
    return out;
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === 'object') collectElements(v, out, depth + 1);
  }
  return out;
}

function shotDir(cfg) {
  const root = (cfg.roots || []).find((r) => r && typeof r === 'string');
  const base = root ? path.join(root, '.arena-bridge', 'shots') : path.join(os.tmpdir(), 'arena-bridge-shots');
  return base;
}

function defaultShotPath(cfg) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(shotDir(cfg), `screen-${stamp}.png`);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true, mode: 0o755 });
}

async function captureScreenFallback(outPath) {
  const res = await run('/usr/sbin/screencapture', ['-x', '-o', outPath], { timeout: 30 });
  if (res.exit_code === 0 && fs.existsSync(outPath)) {
    return { ok: true, path: outPath, backend: 'screencapture' };
  }
  return { ok: false, error: res.stderr.trim() || 'screencapture failed' };
}

const S = (props, required) => ({
  type: 'object',
  properties: props || {},
  required: required || [],
  additionalProperties: false,
});

export function macTools(cfg = {}) {
  const peek = () => findPeekaboo(cfg);

  const needPeek = () => {
    const bin = peek();
    if (!bin) return { ok: false, error: 'peekaboo_not_found', hint: NOT_FOUND_HINT };
    return { ok: true, bin };
  };

  const targetFlags = (args) => {
    const f = [];
    if (args.app) f.push('--app', String(args.app));
    if (args.pid) f.push('--pid', String(args.pid));
    if (args.window_id) f.push('--window-id', String(args.window_id));
    if (args.window_title) f.push('--window-title', String(args.window_title));
    if (args.window_index != null) f.push('--window-index', String(args.window_index));
    return f;
  };

  return [
    {
      name: 'mac_see',
      description:
        'Look at the screen: capture a screenshot (optionally of one app window) and list the clickable elements with their ids. Read-only.',
      approval: false,
      schema: S(
        {
          app: { type: 'string', description: 'application name, e.g. "Safari"' },
          window_title: { type: 'string' },
          mode: { type: 'string', description: 'screen (default) or window' },
          path: { type: 'string', description: 'where to save the PNG (defaults inside the first authorized root)' },
          include_raw: { type: 'boolean' },
        },
        [],
      ),
      required: [],
      handler: async (args, ctx) => {
        const cfg = ctx.cfg || cfg;
        const p = checkPeek(peek());
        if (!p.ok) return p;
        const outPath = args.path ? checkPath(String(args.path), cfg, ctx.base) : { ok: true, abs: defaultShotPath(cfg) };
        if (!outPath.ok) return { ok: false, error: outPath.error, reason: outPath.reason };
        ensureDir(path.dirname(outPath.abs));
        const mode = args.mode === 'window' ? 'window' : 'screen';
        const variants = [
          ['see', '--mode', mode, ...targetFlags(args), '--json', '--path', outPath.abs],
          ['see', '--mode', mode, ...targetFlags(args), '--path', outPath.abs, '--json'],
          ['image', '--mode', mode, ...targetFlags(args), '--json', '--path', outPath.abs],
        ];
        const res = await runVariants(p.bin, variants, { timeout: 60 });
        const json = parseJson(res.stdout);
        const elements = collectElements(json).slice(0, 300);
        const saved = fs.existsSync(outPath.abs);
        if (!saved) {
          const fb = await captureScreenFallback(outPath.abs);
          if (!fb.ok) {
            return {
              ok: false,
              error: 'capture_failed',
              reason: (res.stderr || '').trim().slice(0, 800),
              hint: 'Grant Screen Recording permission to the app that runs the bridge (System Settings → Privacy & Security → Screen Recording).',
            };
          }
        }
        const out = {
          ok: true,
          path: outPath.abs,
          saved,
          elements,
          element_count: elements.length,
          hint: 'Click by element id: mac_click {"on":"<id>"} or by visible text: mac_click {"text":"Save"}',
        };
        if (args.include_raw && json) out.raw = json;
        return out;
      },
    },
    {
      name: 'mac_click',
      description: 'Click on the screen: an element id from mac_see, a visible text, or coordinates.',
      approval: true,
      schema: S(
        {
          on: { type: 'string', description: 'element id from mac_see' },
          text: { type: 'string', description: 'visible text of the element to click' },
          x: { type: 'number' },
          y: { type: 'number' },
          app: { type: 'string' },
          window_id: { type: 'string' },
          window_title: { type: 'string' },
          double: { type: 'boolean' },
          right: { type: 'boolean' },
          foreground: { type: 'boolean', description: 'focus the app before clicking' },
        },
        [],
      ),
      required: [],
      handler: async (args, ctx) => {
        const p = checkPeek(peek());
        if (!p.ok) return p;
        const variants = [];
        const base = ['click'];
        if (args.on) base.push('--on', String(args.on));
        if (args.text) base.push(String(args.text));
        if (args.x != null && args.y != null) base.push('--at', `${args.x},${args.y}`);
        base.push(...targetFlags(args));
        if (args.double) base.push('--double');
        if (args.right) base.push('--right');
        if (args.foreground) base.push('--foreground');
        variants.push(base);
        if (args.text) variants.push(['click', '--on', String(args.text), ...targetFlags(args)]);
        if (args.on) variants.push(['click', '--on', String(args.on)]);
        const res = await runVariants(p.bin, variants, { timeout: 45 });
        return finish(res, 'click');
      },
    },
    {
      name: 'mac_type',
      description: 'Type text into the focused element of an app window.',
      approval: true,
      schema: S(
        {
          text: { type: 'string' },
          app: { type: 'string' },
          window_id: { type: 'string' },
          window_title: { type: 'string' },
          submit: { type: 'boolean', description: 'press Enter afterwards' },
          clear: { type: 'boolean', description: 'clear the field first' },
        },
        ['text'],
      ),
      required: ['text'],
      handler: async (args, ctx) => {
        const p = checkPeek(peek());
        if (!p.ok) return p;
        const flags = targetFlags(args);
        const variants = [
          ['type', String(args.text), ...flags],
          ['type', '--text', String(args.text), ...flags],
        ];
        if (args.clear) variants.unshift(['type', String(args.text), '--clear', ...flags]);
        const res = await runVariants(p.bin, variants, { timeout: 45 });
        if (args.submit && res.exit_code === 0) {
          await run(p.bin, ['press', 'Return', ...flags], { timeout: 20 });
        }
        return finish(res, 'type');
      },
    },
    {
      name: 'mac_key',
      description: 'Press a key or a chord in an app: Return, Tab, Escape, cmd+s, cmd+shift+p, arrows, etc.',
      approval: true,
      schema: S(
        {
          key: { type: 'string', description: 'key name or chord, e.g. "cmd+s"' },
          count: { type: 'number' },
          app: { type: 'string' },
          window_id: { type: 'string' },
        },
        ['key'],
      ),
      required: ['key'],
      handler: async (args, ctx) => {
        const p = checkPeek(peek());
        if (!p.ok) return p;
        const flags = targetFlags(args);
        const count = args.count ? ['--count', String(args.count)] : [];
        const res = await runVariants(
          p.bin,
          [
            ['press', String(args.key), ...count, ...flags],
            ['press', String(args.key), ...flags],
          ],
          { timeout: 30 },
        );
        return finish(res, 'press');
      },
    },
    {
      name: 'mac_scroll',
      description: 'Scroll up/down in the focused app or on a given element.',
      approval: true,
      schema: S(
        {
          direction: { type: 'string', description: 'up or down' },
          ticks: { type: 'number', description: 'how many steps, default 3' },
          on: { type: 'string', description: 'element id from mac_see' },
          app: { type: 'string' },
          window_id: { type: 'string' },
        },
        ['direction'],
      ),
      required: ['direction'],
      handler: async (args, ctx) => {
        const p = checkPeek(peek());
        if (!p.ok) return p;
        const dir = args.direction === 'up' ? 'up' : 'down';
        const flags = targetFlags(args);
        const on = args.on ? ['--on', String(args.on)] : [];
        const res = await runVariants(
          p.bin,
          [
            ['scroll', '--direction', dir, '--ticks', String(args.ticks || 3), ...on, ...flags],
            ['scroll', '--direction', dir, ...on, ...flags],
          ],
          { timeout: 30 },
        );
        return finish(res, 'scroll');
      },
    },
    {
      name: 'mac_move',
      description: 'Move the mouse pointer to coordinates (no click).',
      approval: true,
      schema: S({ x: { type: 'number' }, y: { type: 'number' } }, ['x', 'y']),
      required: ['x', 'y'],
      handler: async (args) => {
        const p = checkPeek(peek());
        if (!p.ok) return p;
        const res = await runVariants(
          p.bin,
          [
            ['move', '--at', `${args.x},${args.y}`],
            ['move', '--coords', `${args.x},${args.y}`],
          ],
          { timeout: 20 },
        );
        return finish(res, 'move');
      },
    },
    {
      name: 'mac_drag',
      description: 'Drag from one point to another (sliders, files, text selection).',
      approval: true,
      schema: S({ from_x: { type: 'number' }, from_y: { type: 'number' }, to_x: { type: 'number' }, to_y: { type: 'number' } }),
      required: ['from_x', 'from_y', 'to_x', 'to_y'],
      handler: async (args) => {
        const p = checkPeek(peek());
        if (!p.ok) return p;
        const res = await runVariants(
          p.bin,
          [['drag', '--from', `${args.from_x},${args.from_y}`, '--to', `${args.to_x},${args.to_y}`]],
          { timeout: 30 },
        );
        return finish(res, 'drag');
      },
    },
    {
      name: 'mac_apps',
      description: 'List running applications with their ids and frontmost state. Read-only.',
      approval: false,
      schema: S({ include_background: { type: 'boolean' } }, []),
      required: [],
      handler: async (args) => {
        const p = checkPeek(peek());
        if (!p.ok) return p;
        const res = await runVariants(
          p.bin,
          [
            ['list', 'apps', '--json'],
            ['app', 'list', '--json'],
            ['list', 'apps'],
          ],
          { timeout: 30 },
        );
        const json = parseJson(res.stdout);
        return {
          ok: res.exit_code === 0,
          apps: json ? (json.apps || json.data?.apps || json) : undefined,
          output: json ? undefined : res.stdout.slice(0, 4000),
          error: res.exit_code === 0 ? undefined : (res.stderr || '').trim().slice(0, 600),
        };
      },
    },
    {
      name: 'mac_windows',
      description: 'List the windows of the running applications (ids, titles, bounds). Read-only.',
      approval: false,
      schema: S({ app: { type: 'string' } }, []),
      required: [],
      handler: async (args) => {
        const p = checkPeek(peek());
        if (!p.ok) return p;
        const flags = args.app ? ['--app', String(args.app)] : [];
        const res = await runVariants(
          p.bin,
          [
            ['list', 'windows', ...flags, '--json'],
            ['window', 'list', ...flags, '--json'],
            ['list', 'windows', ...flags],
          ],
          { timeout: 30 },
        );
        const json = parseJson(res.stdout);
        return {
          ok: res.exit_code === 0,
          windows: json ? (json.windows || json.data?.windows || json) : undefined,
          output: json ? undefined : res.stdout.slice(0, 4000),
          error: res.exit_code === 0 ? undefined : (res.stderr || '').trim().slice(0, 600),
        };
      },
    },
    {
      name: 'mac_app_launch',
      description: 'Launch an application by name.',
      approval: true,
      schema: S({ name: { type: 'string' } }, ['name']),
      required: ['name'],
      handler: async (args) => {
        const p = checkPeek(peek());
        if (!p.ok) return p;
        const res = await runVariants(
          p.bin,
          [
            ['app', 'launch', String(args.name)],
            ['app', 'open', String(args.name)],
          ],
          { timeout: 45 },
        );
        return finish(res, 'launch');
      },
    },
    {
      name: 'mac_app_focus',
      description: 'Bring an application to the front.',
      approval: true,
      schema: S({ name: { type: 'string' } }, ['name']),
      required: ['name'],
      handler: async (args) => {
        const p = checkPeek(peek());
        if (!p.ok) return p;
        const res = await runVariants(
          p.bin,
          [
            ['app', 'focus', String(args.name)],
            ['app', 'switch', String(args.name)],
          ],
          { timeout: 30 },
        );
        return finish(res, 'focus');
      },
    },
    {
      name: 'mac_app_quit',
      description: 'Quit an application.',
      approval: true,
      schema: S({ name: { type: 'string' } }, ['name']),
      required: ['name'],
      handler: async (args) => {
        const p = checkPeek(peek());
        if (!p.ok) return p;
        const res = await runVariants(
          p.bin,
          [
            ['app', 'quit', String(args.name)],
            ['app', 'hide', String(args.name)],
          ],
          { timeout: 30 },
        );
        return finish(res, 'quit');
      },
    },
    {
      name: 'mac_permissions',
      description:
        'Check the macOS permissions the bridge needs (Screen Recording, Accessibility). Read-only — use it when a capture or click fails.',
      approval: false,
      schema: S({}, []),
      required: [],
      handler: async () => {
        const p = checkPeek(peek());
        if (!p.ok) {
          return {
            ok: false,
            error: 'peekaboo_not_found',
            hint: NOT_FOUND_HINT,
            macos_permissions:
              'Screen Recording and Accessibility are required for screen capture and synthetic input.',
          };
        }
        const res = await runVariants(p.bin, [['permissions'], ['permissions', '--json']], { timeout: 30 });
        return {
          ok: res.exit_code === 0,
          permissions: res.stdout.slice(0, 4000) || undefined,
          error: res.exit_code === 0 ? undefined : (res.stderr || '').trim().slice(0, 600),
          hint: 'System Settings → Privacy & Security → Screen Recording / Accessibility → enable the terminal that runs the bridge.',
        };
      },
    },
  ];
}

function checkPeek(p) {
  if (!p) return { ok: false, error: 'peekaboo_not_found', hint: NOT_FOUND_HINT };
  return { ok: true, bin: p };
}

function finish(res, action) {
  if (res.exit_code === 0) return { ok: true, action, output: res.stdout.slice(0, 2000) || undefined };
  return {
    ok: false,
    error: `${action}_failed`,
    reason: (res.stderr || res.stdout || '').trim().slice(0, 800),
    hint: 'If this is a permissions problem, run mac_permissions and check Screen Recording / Accessibility.',
  };
}
