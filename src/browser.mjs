import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CDPClient, browserWsUrl } from './cdp.mjs';
import { checkPath } from './policy.mjs';
import { audit } from './audit.mjs';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

const KEYS = {
  Enter: { code: 'Enter', key: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', key: 'Tab', vk: 9, text: '\t' },
  Escape: { code: 'Escape', key: 'Escape', vk: 27, text: '' },
  Backspace: { code: 'Backspace', key: 'Backspace', vk: 8, text: '' },
  Delete: { code: 'Delete', key: 'Delete', vk: 46, text: '' },
  ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', vk: 38, text: '' },
  ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', vk: 40, text: '' },
  ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', vk: 37, text: '' },
  ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', vk: 39, text: '' },
  Space: { code: 'Space', key: ' ', vk: 32, text: ' ' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const c of CHROME_CANDIDATES) if (fs.existsSync(c)) return c;
  return null;
}

/** Where the named agent profiles live (follows ARENA_BRIDGE_HOME when set). */
export function profileDir() {
  const base = process.env.ARENA_BRIDGE_HOME || path.join(os.homedir(), '.arena-bridge');
  return path.join(base, 'chrome-profiles');
}

export const sanitizeProfile = (name) =>
  String(name)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'default';

/** A named profile keeps its logins between agent runs; a path is used as given. */
export function resolveProfile(raw, port = 9223) {
  if (!raw) return path.join(os.homedir(), '.arena-bridge', `chrome-profile-${port}`);
  const value = String(raw);
  if (value.startsWith('/') || value.startsWith('~')) {
    return path.resolve(value.replace(/^~/, os.homedir()));
  }
  return path.join(profileDir(), sanitizeProfile(value));
}

export function profileName(raw) {
  if (!raw) return null;
  const value = String(raw);
  if (value.startsWith('/') || value.startsWith('~')) return null;
  return sanitizeProfile(value);
}

export function listProfiles() {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(profileDir());
  } catch {
    return out;
  }
  for (const name of names) {
    const dir = path.join(profileDir(), name);
    let stat = null;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    let size = 0;
    try {
      size = fs
        .readdirSync(dir)
        .reduce((acc, f) => acc + (fs.statSync(path.join(dir, f)).size || 0), 0);
    } catch {
      /* ignore */
    }
    out.push({ name, path: dir, mtime: stat.mtimeMs, files: fs.readdirSync(dir).length, approx_bytes: size });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

const S = (props, required) => ({
  type: 'object',
  properties: props || {},
  required: required || [],
  additionalProperties: false,
});

export class BrowserManager {
  constructor(cfg) {
    this.cfg = cfg;
    this.sessions = new Map();
    this._counter = 0;
  }

  /* ---------------- sessions ---------------- */

  list() {
    return [...this.sessions.values()].map((s) => ({
      session_id: s.id,
      managed: s.managed,
      headless: s.headless,
      port: s.port,
      profile: s.profile,
      tabs: [...s.tabs.values()].map((t) => ({ tab_id: t.targetId, title: t.title, url: t.url })),
      created_at: s.createdAt,
    }));
  }

  session(id) {
    if (!id) {
      const first = this.sessions.values().next().value;
      return first || null;
    }
    return this.sessions.get(id) || null;
  }

  async _attachTarget(session, targetId) {
    const { sessionId } = await session.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = session.tabs.get(targetId) || { targetId, sessionId, title: '', url: '' };
    tab.sessionId = sessionId;
    session.tabs.set(targetId, tab);
    try {
      await session.cdp.send('Page.enable', {}, sessionId);
      await session.cdp.send('Runtime.enable', {}, sessionId);
    } catch {
      /* some targets do not support these domains */
    }
    return tab;
  }

  async _newSession({ cdp, port, managed, headless, profile, proc }) {
    const id = `chrome_${++this._counter}`;
    const session = {
      id,
      cdp,
      port,
      managed,
      headless,
      profile,
      proc,
      tabs: new Map(),
      createdAt: Date.now(),
    };
    this.sessions.set(id, session);
    cdp.on('close', () => {
      this.sessions.delete(id);
    });
    return session;
  }

  async _collectTabs(session) {
    const { targetInfos } = await session.cdp.send('Target.getTargets');
    for (const t of targetInfos) {
      if (t.type !== 'page') continue;
      const existing = session.tabs.get(t.targetId);
      if (existing) {
        existing.title = t.title;
        existing.url = t.url;
      }
    }
    for (const t of targetInfos) {
      if (t.type !== 'page') continue;
      if (!session.tabs.has(t.targetId)) {
        await this._attachTarget(session, t.targetId);
        const tab = session.tabs.get(t.targetId);
        tab.title = t.title;
        tab.url = t.url;
      }
    }
    return [...session.tabs.values()];
  }

  /* ---------------- launch / attach ---------------- */

  async launch(args, ctx) {
    const bin = findChrome();
    if (!bin) {
      return { ok: false, error: 'Chrome not found', reason: 'set CHROME_PATH or install Google Chrome' };
    }
    const headless = args.headless !== false;
    const port = Number(args.port || 9223);
    const profile = resolveProfile(args.profile, port);

    fs.mkdirSync(profile, { recursive: true });

    const chromeArgs = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-features=Translate,MediaRouter',
      '--remote-allow-origins=*',
    ];
    if (headless) chromeArgs.push(process.env.ARENA_HEADLESS_FLAG || '--headless=new');
    if (!headless) {
      const width = Number(args.width || 0);
      const height = Number(args.height || 0);
      if (width && height) chromeArgs.push(`--window-size=${width},${height}`);
      if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) {
        chromeArgs.push(`--window-position=${Number(args.x)},${Number(args.y)}`);
      }
    }
    if (args.url) chromeArgs.push(String(args.url));

    const proc = spawn(bin, chromeArgs, { detached: true, stdio: 'ignore' });
    proc.unref();

    let wsUrl = null;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try {
        wsUrl = await browserWsUrl(port);
        break;
      } catch {
        /* not up yet */
      }
    }
    if (!wsUrl) {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      return { ok: false, error: 'Chrome did not expose a CDP endpoint in time' };
    }

    const cdp = new CDPClient(wsUrl);
    await cdp.connect();
    const session = await this._newSession({ cdp, port, managed: true, headless, profile, proc });
    await this._collectTabs(session);

    return {
      ok: true,
      session_id: session.id,
      managed: true,
      headless,
      port,
      profile,
      profile_name: profileName(args.profile),
      ws_url: wsUrl,
      tabs: [...session.tabs.values()].map((t) => ({ tab_id: t.targetId, title: t.title, url: t.url })),
      note: 'This browser belongs to the agent — no local approval needed for actions on it.',
    };
  }

  async attach(args, ctx) {
    const port = Number(args.port || 9222);
    let wsUrl;
    try {
      wsUrl = await browserWsUrl(port);
    } catch (e) {
      return {
        ok: false,
        error: 'cannot reach Chrome DevTools',
        reason:
          `no CDP endpoint on 127.0.0.1:${port}. Launch Chrome with: ` +
          `open -na "Google Chrome" --args --remote-debugging-port=${port} --user-data-dir="$HOME/.chrome-debug"`,
      };
    }
    const cdp = new CDPClient(wsUrl);
    await cdp.connect();
    const session = await this._newSession({ cdp, port, managed: false, headless: false, profile: null, proc: null });
    const tabs = await this._collectTabs(session);
    return {
      ok: true,
      session_id: session.id,
      managed: false,
      port,
      ws_url: wsUrl,
      tabs: tabs.map((t) => ({ tab_id: t.targetId, title: t.title, url: t.url })),
      note:
        'This is the user\'s own Chrome with their real profile. Every action on it requires a local approval.',
    };
  }

  async stop(args) {
    const targets = args.session_id ? [this.sessions.get(args.session_id)] : [...this.sessions.values()];
    const stopped = [];
    for (const s of targets) {
      if (!s) continue;
      if (!s.managed) {
        return { ok: false, error: 'refusing to stop an attached (user) browser', session_id: s.id };
      }
      try {
        s.cdp.close();
      } catch {
        /* ignore */
      }
      try {
        s.proc?.kill();
      } catch {
        /* ignore */
      }
      this.sessions.delete(s.id);
      stopped.push(s.id);
    }
    return { ok: true, stopped };
  }

  /* ---------------- tab helpers ---------------- */

  async _tab(session, tabId) {
    if (!tabId) {
      const first = session.tabs.values().next().value;
      if (!first) throw new Error('no open tabs');
      return first;
    }
    const tab = session.tabs.get(tabId);
    if (!tab) throw new Error(`unknown tab: ${tabId}`);
    return tab;
  }

  async _eval(session, tab, expression) {
    const res = await session.cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      tab.sessionId,
    );
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || 'page evaluation failed');
    }
    return res.result?.value;
  }

  /* ---------------- tool definitions ---------------- */

  tools() {
    const needSession = (args, ctx, { managedOnly = false } = {}) => {
      const session = ctx.browser.session(args.session_id);
      if (!session) throw new Error('no browser session — call chrome_launch or chrome_attach first');
      if (managedOnly && !session.managed) throw new Error('this session is not an agent-owned browser');
      return session;
    };

    const requiresApproval = (args, ctx) => {
      const session = ctx.browser.session(args.session_id);
      // the agent's own browser is free; the user's real Chrome needs a human
      return !(session && session.managed);
    };

    return [
      {
        name: 'chrome_launch',
        description:
          'Start a Chrome instance owned by the agent (its own profile, no personal data) and attach to it over CDP. ' +
          'headless=true runs it without a window; headless=false opens a visible window. Use it for automated browsing, ' +
          'screenshots and scraping. No local approval is needed for actions on this browser.',
        approval: false,
        schema: S(
          {
            headless: { type: 'boolean', description: 'true (default) = no window, false = visible window' },
            port: { type: 'number', description: 'CDP port (default 9223)' },
            url: { type: 'string', description: 'URL to open on start' },
            profile: {
              type: 'string',
              description:
                'named profile (keeps its logins between runs) or a directory path. ' +
                'Default: a throwaway profile for this port.',
            },
            width: { type: 'number', description: 'window width in pixels (visible window only)' },
            height: { type: 'number', description: 'window height in pixels (visible window only)' },
            x: { type: 'number', description: 'window left edge, e.g. -900 puts it on the left of a wide screen' },
            y: { type: 'number', description: 'window top edge' },
          },
          [],
        ),
        required: [],
        handler: (args, ctx) => ctx.browser.launch(args, ctx),
      },
      {
        name: 'chrome_profiles',
        description:
          'List the agent\'s own named browser profiles (each keeps its own logins between runs). ' +
          'Launch one with chrome_launch {"profile":"<name>"}; the user logs into it once with ' +
          '"arena-bridge browser open <name>" on their machine.',
        approval: false,
        schema: S({}, []),
        required: [],
        handler: async () => {
          const profiles = listProfiles();
          return {
            ok: true,
            count: profiles.length,
            profiles,
            hint: 'Ask the user to log in: arena-bridge browser open <name> — then use chrome_launch {"profile":"<name>"}',
          };
        },
      },
      {
        name: 'chrome_attach',
        description:
          'Attach to a Chrome instance that is already running with --remote-debugging-port (typically the user\'s own ' +
          'browser on port 9222, with their logged-in sessions). Every action on an attached browser requires a local approval.',
        approval: false,
        schema: S({ port: { type: 'number', description: 'CDP port (default 9222)' } }, []),
        required: [],
        handler: (args, ctx) => ctx.browser.attach(args, ctx),
      },
      {
        name: 'chrome_tabs',
        description: 'List the open tabs of a browser session (or of all sessions).',
        approval: false,
        schema: S({ session_id: { type: 'string' } }, []),
        required: [],
        handler: (args, ctx) => {
          if (!args.session_id) return { ok: true, sessions: ctx.browser.list() };
          const session = needSession(args, ctx);
          return {
            ok: true,
            session_id: session.id,
            tabs: [...session.tabs.values()].map((t) => ({ tab_id: t.targetId, title: t.title, url: t.url })),
          };
        },
      },
      {
        name: 'chrome_open',
        description: 'Open a URL in the browser (new tab by default).',
        approval: true,
        approvalFor: requiresApproval,
        schema: S(
          {
            url: { type: 'string' },
            session_id: { type: 'string' },
            new_tab: { type: 'boolean', description: 'default true' },
            tab_id: { type: 'string', description: 'existing tab to navigate instead of creating one' },
          },
          ['url'],
        ),
        required: ['url'],
        handler: async (args, ctx) => {
          const session = needSession(args, ctx);
          const url = String(args.url);
          let tab;
          if (args.tab_id) {
            tab = await this._tab(session, args.tab_id);
            await session.cdp.send('Page.navigate', { url }, tab.sessionId);
          } else if (args.new_tab === false) {
            tab = await this._tab(session, null);
            await session.cdp.send('Page.navigate', { url }, tab.sessionId);
          } else {
            const { targetId } = await session.cdp.send('Target.createTarget', { url });
            tab = await this._attachTarget(session, targetId);
            tab.url = url;
          }
          await sleep(400);
          return { ok: true, session_id: session.id, tab_id: tab.targetId, url };
        },
      },
      {
        name: 'chrome_navigate',
        description: 'Navigate an existing tab to a URL.',
        approval: true,
        approvalFor: requiresApproval,
        schema: S({ url: { type: 'string' }, session_id: { type: 'string' }, tab_id: { type: 'string' } }, ['url']),
        required: ['url'],
        handler: async (args, ctx) => {
          const session = needSession(args, ctx);
          const tab = await this._tab(session, args.tab_id);
          const res = await session.cdp.send('Page.navigate', { url: String(args.url) }, tab.sessionId);
          return { ok: true, session_id: session.id, tab_id: tab.targetId, frame_id: res.frameId };
        },
      },
      {
        name: 'chrome_snapshot',
        description:
          'Read the page content: mode=text (visible text, default), html (markup) or ax (accessibility tree with roles and names).',
        approval: false,
        schema: S(
          {
            session_id: { type: 'string' },
            tab_id: { type: 'string' },
            mode: { type: 'string', description: 'text | html | ax' },
            max_chars: { type: 'number' },
          },
          [],
        ),
        required: [],
        handler: async (args, ctx) => {
          const session = needSession(args, ctx);
          const tab = await this._tab(session, args.tab_id);
          const max = Math.min(Number(args.max_chars || 20000), 200000);
          const mode = args.mode || 'text';
          if (mode === 'ax') {
            const { nodes } = await session.cdp.send('Accessibility.getFullAXTree', {}, tab.sessionId);
            const flat = (nodes || [])
              .filter((n) => n.role?.value && n.role.value !== 'none')
              .map((n) => ({ role: n.role.value, name: n.name?.value || '' }))
              .filter((n) => n.name)
              .slice(0, 500);
            return { ok: true, tab_id: tab.targetId, mode, nodes: flat };
          }
          const expr =
            mode === 'html'
              ? 'document.documentElement.outerHTML'
              : '({title: document.title, url: location.href, text: document.body ? document.body.innerText : ""})';
          const value = await this._eval(session, tab, expr);
          if (mode === 'html') {
            const s = String(value ?? '');
            return { ok: true, tab_id: tab.targetId, mode, html: s.slice(0, max), truncated: s.length > max };
          }
          const v = value || {};
          const text = String(v.text ?? '');
          return {
            ok: true,
            tab_id: tab.targetId,
            mode,
            title: v.title,
            url: v.url,
            text: text.slice(0, max),
            truncated: text.length > max,
          };
        },
      },
      {
        name: 'chrome_click',
        description:
          'Click an element — by CSS selector or by visible text. Also accepts a zero-based index from the accessibility snapshot.',
        approval: true,
        approvalFor: requiresApproval,
        schema: S(
          {
            session_id: { type: 'string' },
            tab_id: { type: 'string' },
            selector: { type: 'string', description: 'CSS selector' },
            text: { type: 'string', description: 'visible text of the element to click' },
            index: { type: 'number', description: 'index within the ax snapshot' },
          },
          [],
        ),
        required: [],
        handler: async (args, ctx) => {
          const session = needSession(args, ctx);
          const tab = await this._tab(session, args.tab_id);
          let expr;
          if (args.selector) {
            expr = `(() => { const el = document.querySelector(${JSON.stringify(args.selector)}); if (!el) return {clicked:false, reason:'not found'}; el.scrollIntoView({block:'center'}); el.click(); return {clicked:true, tag: el.tagName, text: (el.innerText||'').slice(0,120)}; })()`;
          } else if (args.text) {
            expr = `(() => { const t = ${JSON.stringify(String(args.text).toLowerCase())}; const els = [...document.querySelectorAll('a,button,[role=button],input[type=submit],input[type=button],label,span,div')].filter(e => (e.innerText||e.value||'').trim().toLowerCase() === t); const el = els[0]; if (!el) return {clicked:false, reason:'no element with that text'}; el.scrollIntoView({block:'center'}); el.click(); return {clicked:true, tag: el.tagName, text: (el.innerText||'').slice(0,120)}; })()`;
          } else if (args.index !== undefined) {
            expr = `(() => { const els = [...document.querySelectorAll('a,button,[role=button],input')].filter(e => (e.innerText||e.value||'').trim()); const el = els[${Number(args.index)}]; if (!el) return {clicked:false, reason:'index out of range'}; el.scrollIntoView({block:'center'}); el.click(); return {clicked:true, tag: el.tagName, text: (el.innerText||'').slice(0,120)}; })()`;
          } else {
            return { ok: false, error: 'provide selector, text or index' };
          }
          const res = await this._eval(session, tab, expr);
          return { ok: !!(res && res.clicked), tab_id: tab.targetId, ...(res || {}) };
        },
      },
      {
        name: 'chrome_type',
        description: 'Type text into an input field (by CSS selector) and optionally submit it with Enter.',
        approval: true,
        approvalFor: requiresApproval,
        schema: S(
          {
            selector: { type: 'string' },
            text: { type: 'string' },
            session_id: { type: 'string' },
            tab_id: { type: 'string' },
            submit: { type: 'boolean', description: 'press Enter afterwards' },
            clear: { type: 'boolean', description: 'clear the field first (default true)' },
          },
          ['selector', 'text'],
        ),
        required: ['selector', 'text'],
        handler: async (args, ctx) => {
          const session = needSession(args, ctx);
          const tab = await this._tab(session, args.tab_id);
          const expr = `(() => {
            const el = document.querySelector(${JSON.stringify(args.selector)});
            if (!el) return {ok:false, reason:'field not found'};
            el.focus();
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            ${args.clear === false ? '' : "setter.call(el, '');"}
            setter.call(el, ${JSON.stringify(String(args.text))});
            el.dispatchEvent(new Event('input', {bubbles:true}));
            el.dispatchEvent(new Event('change', {bubbles:true}));
            return {ok:true, value: el.value};
          })()`;
          const res = await this._eval(session, tab, expr);
          if (!res || !res.ok) return { ok: false, error: res?.reason || 'typing failed', tab_id: tab.targetId };
          if (args.submit) {
            await this._press(session, tab, 'Enter');
          }
          return { ok: true, tab_id: tab.targetId, value: res.value, submitted: !!args.submit };
        },
      },
      {
        name: 'chrome_press',
        description: 'Press a key in the page (Enter, Tab, Escape, ArrowUp/Down/Left/Right, Backspace, Delete, Space).',
        approval: true,
        approvalFor: requiresApproval,
        schema: S({ key: { type: 'string' }, session_id: { type: 'string' }, tab_id: { type: 'string' } }, ['key']),
        required: ['key'],
        handler: async (args, ctx) => {
          const session = needSession(args, ctx);
          const tab = await this._tab(session, args.tab_id);
          await this._press(session, tab, String(args.key));
          return { ok: true, tab_id: tab.targetId, key: String(args.key) };
        },
      },
      {
        name: 'chrome_screenshot',
        description:
          'Capture a PNG screenshot of a tab. If "path" is given, the image is saved there (inside the authorized roots) ' +
          'and the file can be read afterwards; otherwise the PNG is returned as base64.',
        approval: false,
        schema: S(
          {
            path: { type: 'string', description: 'where to save the PNG (must be inside the authorized roots)' },
            session_id: { type: 'string' },
            tab_id: { type: 'string' },
            full_page: { type: 'boolean' },
          },
          [],
        ),
        required: [],
        handler: async (args, ctx) => {
          const session = needSession(args, ctx);
          const tab = await this._tab(session, args.tab_id);
          const params = { format: 'png' };
          if (args.full_page) {
            const metrics = await session.cdp.send('Page.getLayoutMetrics', {}, tab.sessionId);
            const size = metrics?.cssContentSize || metrics?.contentSize;
            if (size) {
              params.clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
              params.captureBeyondViewport = true;
            }
          }
          const { data } = await session.cdp.send('Page.captureScreenshot', params, tab.sessionId);
          const b64 = String(data || '');
          if (args.path) {
            const chk = checkPath(args.path, ctx.cfg, ctx.base, { write: true });
            if (!chk.ok) return { ok: false, error: chk.error, reason: chk.reason };
            fs.mkdirSync(path.dirname(chk.abs), { recursive: true });
            fs.writeFileSync(chk.abs, Buffer.from(b64, 'base64'));
            audit({ tool: 'chrome_screenshot', args, status: 'ok', path: chk.abs });
            return { ok: true, tab_id: tab.targetId, path: chk.abs, bytes: Math.round((b64.length * 3) / 4) };
          }
          return { ok: true, tab_id: tab.targetId, image_base64: b64, bytes: Math.round((b64.length * 3) / 4) };
        },
      },
      {
        name: 'chrome_evaluate',
        description:
          'Run arbitrary JavaScript in the page and return the result. Escape hatch for things the other tools do not cover.',
        approval: true,
        approvalFor: requiresApproval,
        schema: S({ expression: { type: 'string' }, session_id: { type: 'string' }, tab_id: { type: 'string' } }, ['expression']),
        required: ['expression'],
        handler: async (args, ctx) => {
          const session = needSession(args, ctx);
          const tab = await this._tab(session, args.tab_id);
          const value = await this._eval(session, tab, String(args.expression));
          return { ok: true, tab_id: tab.targetId, value };
        },
      },
      {
        name: 'chrome_stop',
        description: 'Close a browser session that the agent started (agent-owned browsers only).',
        approval: false,
        schema: S({ session_id: { type: 'string' } }, []),
        required: [],
        handler: (args, ctx) => ctx.browser.stop(args),
      },
    ];
  }

  async _press(session, tab, key) {
    const spec = KEYS[key] || {
      code: key,
      key,
      vk: key.toUpperCase().charCodeAt(0),
      text: key.length === 1 ? key : '',
    };
    const base = {
      windowsVirtualKeyCode: spec.vk,
      nativeVirtualKeyCode: spec.vk,
      key: spec.key,
      code: spec.code,
    };
    await session.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: spec.text }, tab.sessionId);
    if (spec.text) {
      await session.cdp.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: spec.text }, tab.sessionId);
    }
    await session.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, tab.sessionId);
  }
}
