import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import net from 'node:net';
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

/** Pids of processes whose command line uses this Chrome user-data-dir. */
export function profilePids(profile) {
  return new Promise((resolve) => {
    execFile('ps', ['-Ao', 'pid=,command='], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve([]);
      const needle = `--user-data-dir=${profile}`;
      const out = [];
      for (const line of String(stdout).split('\n')) {
        if (!line.includes(needle)) continue;
        const pid = Number(line.trim().split(/\s+/)[0]);
        if (pid && pid !== process.pid) out.push(pid);
      }
      resolve(out);
    });
  });
}

/** A free TCP port on localhost, for a CDP endpoint nobody else owns. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Kill leftover agent-owned headless Chromes (managed profiles only).
 * A visible browser the human opened to log in is never touched.
 */
export async function cleanupOrphanChromes(sessions = []) {
  const keep = new Set(sessions.map((s) => s.proc?.pid).filter(Boolean));
  const managedRoots = [profileDir() + path.sep, path.join(os.homedir(), '.arena-bridge', 'chrome-profile-')];
  return new Promise((resolve) => {
    execFile('ps', ['-Ao', 'pid=,command='], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(0);
      let killed = 0;
      for (const line of String(stdout).split('\n')) {
        if (!line.includes('--user-data-dir=') || !line.includes('--headless')) continue;
        if (!managedRoots.some((r) => line.includes(r))) continue;
        const pid = Number(line.trim().split(/\s+/)[0]);
        if (!pid || pid === process.pid || keep.has(pid)) continue;
        try { process.kill(pid, 'SIGTERM'); killed++; } catch { /* already gone */ }
      }
      resolve(killed);
    });
  });
}

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
      disconnected: !!s.disconnected,
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
      observe: new Map(),
      createdAt: Date.now(),
      disconnected: false,
      terminated: false,
      reconnecting: false,
      reconnects: 0,
    };
    // H1/R6: limit Chrome sessions to 10, clean oldest and TTL 24h
    if (this.sessions.size >= 10) {
      let oldest = null;
      for (const s of this.sessions.values()) {
        if (!oldest || (s.startedAt || 0) < (oldest.startedAt || 0)) oldest = s;
      }
      if (oldest) {
        try { oldest.proc?.kill(); } catch {}
        this.sessions.delete(oldest.id || oldest.session_id);
      }
    }
    // cleanup expired (>24h)
    const now = Date.now();
    for (const [k, s] of this.sessions) {
      if (now - (s.startedAt || now) > 24*3600*1000) {
        try { s.proc?.kill(); } catch {}
        this.sessions.delete(k);
      }
    }
    this.sessions.set(id, session);
    this._wireCdp(session);
    return session;
  }

  _wireCdp(session) {
    session.cdp.on('close', () => {
      if (session.terminated) {
        this.sessions.delete(session.id);
        return;
      }
      // Chrome may drop an idle DevTools socket while the browser itself is
      // fine. Keep the session (tabs, observations) and reconnect in the
      // background instead of failing every later call with a dead session.
      session.disconnected = true;
      void this._reconnect(session);
    });
  }

  async _reconnect(session) {
    if (session.reconnecting || session.terminated || !session.port) return;
    session.reconnecting = true;
    try {
      for (let attempt = 0; attempt < 60 && !session.terminated; attempt++) {
        await sleep(1000);
        try {
          const wsUrl = await browserWsUrl(session.port);
          const cdp = new CDPClient(wsUrl);
          await cdp.connect();
          if (session.terminated) {
            cdp.close();
            return;
          }
          session.cdp = cdp;
          this._wireCdp(session);
          const { targetInfos } = await cdp.send('Target.getTargets');
          const alive = new Set();
          for (const t of targetInfos) {
            if (t.type !== 'page') continue;
            alive.add(t.targetId);
            const tab = await this._attachTarget(session, t.targetId);
            tab.title = t.title;
            tab.url = t.url;
          }
          for (const targetId of [...session.tabs.keys()]) {
            if (!alive.has(targetId)) session.tabs.delete(targetId);
          }
          session.disconnected = false;
          session.reconnects++;
          return;
        } catch {
          /* Chrome not reachable yet — keep retrying */
        }
      }
      this.sessions.delete(session.id);
    } finally {
      session.reconnecting = false;
    }
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
    const port = Number(args.port) || (await freePort());
    const profile = resolveProfile(args.profile, port);

    // One profile = one Chrome. Refuse a second owner instead of corrupting
    // the profile or failing later with a locked user-data-dir.
    for (const s of this.sessions.values()) {
      if (s.profile === profile) {
        return { ok: false, error: 'profile_busy', profile, session_id: s.id,
          hint: 'This profile is already running in a browser session — reuse it or chrome_stop it first.' };
      }
      if (s.port === port) {
        return { ok: false, error: 'port_busy', port, session_id: s.id,
          hint: 'That CDP port already belongs to another browser session — omit "port" to get a free one.' };
      }
    }
    const external = await profilePids(profile).catch(() => []);
    if (external.length) {
      return { ok: false, error: 'profile_busy', profile, pids: external,
        hint: 'A Chrome with this profile is already running (for example a "browser login" window). Close it, then retry.' };
    }

    fs.mkdirSync(profile, { recursive: true });

    // Kept as close to a plain Chrome launch as possible (only the CDP port is
    // added): sync/background/feature kill-switches made sites behave oddly
    // and can invalidate sessions the user created in the plain login browser.
    const chromeArgs = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
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
      s.terminated = true;
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

  /* ---------------- observe / semantic actions ---------------- */

  async _observe(session, tab, args = {}) {
    const limit = Math.max(1, Math.min(Number(args.limit || args.max_elements || 80), 300));
    const textLimit = Math.max(0, Math.min(Number(args.text_limit || 6000), 50000));
    const id = `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const expr = `(() => { /*arena-observe*/
      const LIMIT = ${limit}, TEXT_LIMIT = ${textLimit};
      document.querySelectorAll('[data-arena-bridge-ref]').forEach((e) => e.removeAttribute('data-arena-bridge-ref'));
      const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      const name = (e) => (e.getAttribute('aria-label') || e.innerText || e.value ||
        e.getAttribute('placeholder') || e.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 160);
      const role = (e) => e.getAttribute('role') || ({A:'link',BUTTON:'button',TEXTAREA:'textbox',
        SELECT:'combobox',INPUT:(e.type === 'checkbox' ? 'checkbox' : e.type === 'radio' ? 'radio' : 'textbox')}[e.tagName] || e.tagName.toLowerCase());
      const state = (e) => { const st = {};
        const put = (k, v) => { if (v !== null && v !== undefined) st[k] = (v === 'true' ? true : v === 'false' ? false : v); };
        put('pressed', e.getAttribute('aria-pressed')); put('selected', e.getAttribute('aria-selected'));
        put('checked', e.getAttribute('aria-checked') !== null ? e.getAttribute('aria-checked') : (typeof e.checked === 'boolean' ? String(e.checked) : null));
        put('expanded', e.getAttribute('aria-expanded')); put('disabled', e.disabled || e.getAttribute('aria-disabled'));
        st.focused = (document.activeElement === e); return st; };
      const SEL = 'a,button,input,textarea,select,summary,[contenteditable],[role="button"],[role="textbox"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[role="option"],[role="switch"],[role="combobox"],[role="slider"],[role="link"]';
      const els = [...document.querySelectorAll(SEL)].filter(vis);
      const elements = els.slice(0, LIMIT).map((e, i) => { const ref = 'el_' + i;
        e.setAttribute('data-arena-bridge-ref', ref);
        return { ref, role: role(e), name: name(e), tag: e.tagName.toLowerCase(), state: state(e) }; });
      const dialogs = [...document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"]')].filter(vis)
        .map((d) => ({ text: (d.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 500),
          buttons: [...d.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"]')]
            .map((b) => name(b)).filter(Boolean).slice(0, 12) }));
      const editorSel = 'textarea,[contenteditable="true"],[contenteditable=""],[role="textbox"],input[type="text"],input[type="search"],input[type="email"],input[type="url"],input:not([type])';
      const editors = [...document.querySelectorAll(editorSel)].filter(vis);
      const ed = document.activeElement && editors.includes(document.activeElement) ? document.activeElement : editors[0];
      const composer = ed ? { kind: ed.getAttribute('contenteditable') !== null ? 'contenteditable' : ed.tagName.toLowerCase(),
        text: (ed.value !== undefined ? ed.value : (ed.innerText || '')).slice(0, 500), focused: document.activeElement === ed } : null;
      return { title: document.title, url: location.href,
        text: document.body ? (document.body.innerText || '').slice(0, TEXT_LIMIT) : '',
        elements, dialogs, composer, element_total: els.length, truncated: els.length > elements.length };
    })()`;
    const value = (await this._eval(session, tab, expr)) || {};
    const refs = new Set((value.elements || []).map((e) => e.ref));
    session.observe.set(tab.targetId, { id, refs, url: value.url || tab.url });
    return { ok: true, session_id: session.id, tab_id: tab.targetId, snapshot_id: id, ...value };
  }

  async _clickRef(session, tab, args) {
    const snap = session.observe.get(tab.targetId);
    if (!snap || !snap.refs.has(String(args.ref)) || (args.snapshot_id && args.snapshot_id !== snap.id)) {
      return { ok: false, error: 'stale_ref', ref: args.ref,
        reason: 'That element ref is not in the latest observation of this tab — call chrome_observe again.' };
    }
    const expr = `(() => { /*arena-click-ref*/
      const el = document.querySelector('[data-arena-bridge-ref="' + ${JSON.stringify(String(args.ref))} + '"]');
      if (!el) return { clicked: false, reason: 'element no longer in the page' };
      el.scrollIntoView({ block: 'center' }); el.click();
      return { clicked: true, tag: el.tagName, text: (el.innerText || el.value || '').slice(0, 120) }; })()`;
    const res = await this._eval(session, tab, expr);
    if (!res || !res.clicked) {
      return { ok: false, error: 'stale_ref', ref: args.ref, reason: res?.reason || 'click failed' };
    }
    return { ok: true, tab_id: tab.targetId, ref: args.ref, ...res };
  }

  async _fillEditor(session, tab, args) {
    const focusExpr = `(() => { /*arena-fill-focus*/
      const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && !e.disabled; };
      const sel = 'textarea,[contenteditable="true"],[contenteditable=""],[role="textbox"],input[type="text"],input[type="search"],input[type="email"],input[type="url"],input[type="tel"],input:not([type])';
      const eds = [...document.querySelectorAll(sel)].filter(vis);
      const ed = (document.activeElement && eds.includes(document.activeElement)) ? document.activeElement : eds[0];
      if (!ed) return { ok: false, reason: 'no visible editor found' };
      ed.focus();
      const ce = ed.getAttribute('contenteditable') !== null && ed.tagName !== 'TEXTAREA' && ed.tagName !== 'INPUT';
      if (${args.clear === false ? 'false' : 'true'}) {
        if (ce) { document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); }
        else { const proto = ed instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set; setter.call(ed, '');
          ed.dispatchEvent(new Event('input', { bubbles: true })); }
      } else if (ce) { const range = document.createRange(); range.selectNodeContents(ed); range.collapse(false);
        const sel2 = getSelection(); sel2.removeAllRanges(); sel2.addRange(range); }
      return { ok: true, kind: ce ? 'contenteditable' : ed.tagName.toLowerCase() }; })()`;
    const focused = await this._eval(session, tab, focusExpr);
    if (!focused || !focused.ok) return { ok: false, error: focused?.reason || 'no visible editor found', tab_id: tab.targetId };
    if (String(args.text ?? '')) {
      await session.cdp.send('Input.insertText', { text: String(args.text) }, tab.sessionId);
    }
    const read = await this._eval(session, tab, `(() => { /*arena-fill-read*/
      const ed = document.activeElement;
      if (!ed) return { ok: false, value: '' };
      return { ok: true, value: (ed.value !== undefined ? ed.value : (ed.innerText || '')).slice(0, 2000) }; })()`);
    return { ok: true, tab_id: tab.targetId, kind: focused.kind, value: read?.value ?? '' };
  }

  async _waitFor(session, tab, cond, timeoutSec) {
    const deadline = Date.now() + Math.max(1, Math.min(Number(timeoutSec) || 15, 120)) * 1000;
    const condJson = JSON.stringify(cond || {});
    const expr = `(() => { /*arena-wait-check*/
      const c = ${condJson};
      const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      const name = (e) => (e.getAttribute('aria-label') || e.innerText || e.value || e.getAttribute('placeholder') || '').trim();
      const role = (e) => e.getAttribute('role') || e.tagName.toLowerCase();
      const bodyText = document.body ? (document.body.innerText || '') : '';
      switch (c.type) {
        case 'text_present': return bodyText.includes(c.text || '');
        case 'text_absent': return !bodyText.includes(c.text || '');
        case 'dialog_closed': return ![...document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"]')].some(vis);
        case 'composer_empty': { const sel = 'textarea,[contenteditable],[role="textbox"],input[type="text"],input[type="search"],input:not([type])';
          const ed = [...document.querySelectorAll(sel)].filter(vis)[0]; if (!ed) return false;
          return ((ed.value !== undefined ? ed.value : (ed.innerText || '')).trim() === ''); }
        case 'element_present': case 'element_absent': {
          const els = [...document.querySelectorAll('a,button,input,textarea,select,[contenteditable],[role]')].filter(vis);
          const found = els.some((e) => (!c.text || name(e).toLowerCase().includes(String(c.text).toLowerCase())) &&
            (!c.role || role(e).toLowerCase().includes(String(c.role).toLowerCase())) &&
            (!c.name || name(e).toLowerCase().includes(String(c.name).toLowerCase())));
          return c.type === 'element_present' ? found : !found; }
        default: return false;
      } })()`;
    for (;;) {
      let ok = false;
      try { ok = !!(await this._eval(session, tab, expr)); } catch { ok = false; }
      if (ok) return true;
      if (Date.now() >= deadline) return false;
      await sleep(500);
    }
  }

  async _withExpect(session, tab, args, result) {
    if (!args.expect || !result || result.ok === false) return result;
    const verified = await this._waitFor(session, tab, args.expect, args.expect.timeout_sec || 10);
    return { ...result, verified, expect: args.expect };
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
            port: { type: 'number', description: 'CDP port (omit to get a free port automatically)' },
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
          '"arena-bridge browser login <name>" on their machine.',
        approval: false,
        schema: S({}, []),
        required: [],
        handler: async (args, ctx) => {
          const sessions = ctx.browser.list();
          const profiles = listProfiles().map((p) => {
            const s = sessions.find((x) => x.profile === p.path);
            return { ...p, running: !!s, port: s ? s.port : null, session_id: s ? s.session_id : null };
          });
          return {
            ok: true,
            count: profiles.length,
            profiles,
            hint: 'Ask the user to log in: arena-bridge browser login <name> — then use chrome_launch {"profile":"<name>"}',
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
        name: 'chrome_activate',
        description:
          'Make a tab the active one inside its Chrome window (Target.activateTarget). This does NOT move the ' +
          "user's mouse cursor and does not steal OS focus — the window is not raised; only the selected tab " +
          'changes. Some pages pause timers/rendering in background tabs, so activating the tab you are about ' +
          'to work with makes interactions more reliable.',
        approval: true,
        approvalFor: requiresApproval,
        schema: S({ session_id: { type: 'string' }, tab_id: { type: 'string' } }, []),
        required: [],
        handler: async (args, ctx) => {
          const session = needSession(args, ctx);
          const tab = await this._tab(session, args.tab_id);
          await session.cdp.send('Target.activateTarget', { targetId: tab.targetId });
          return { ok: true, session_id: session.id, tab_id: tab.targetId };
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
              .map((n) => {
                const state = {};
                for (const prop of n.properties || []) {
                  const v = prop.value?.value;
                  if (v !== undefined && v !== null && v !== '') state[prop.name] = v;
                }
                const out = { role: n.role.value, name: n.name?.value || '' };
                if (Object.keys(state).length) out.state = state;
                return out;
              })
              .filter((n) => n.name)
              .slice(0, 500);
            const dialogs = flat
              .filter((n) => n.role === 'dialog' || n.role === 'alertdialog')
              .map((n) => ({ name: n.name }));
            return { ok: true, tab_id: tab.targetId, mode, nodes: flat, dialogs };
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
        name: 'chrome_observe',
        description:
          'Observe a page for action: visible interactive elements with refs and states ' +
          '(pressed/selected/checked), open dialogs, and the current text editor with its content. ' +
          'Refs from the result can be clicked with chrome_click {"ref": "..."}. Read-only.',
        approval: false,
        schema: S(
          {
            session_id: { type: 'string' },
            tab_id: { type: 'string' },
            limit: { type: 'number', description: 'max elements (default 80, max 300)' },
            text_limit: { type: 'number', description: 'max chars of visible page text (default 6000)' },
          },
          [],
        ),
        required: [],
        handler: async (args, ctx) => {
          const session = needSession(args, ctx);
          const tab = await this._tab(session, args.tab_id);
          return ctx.browser._observe(session, tab, args);
        },
      },
      {
        name: 'chrome_fill_editor',
        description:
          'Find the visible text editor on the page (textarea, contenteditable or textbox), ' +
          'optionally clear it, type text with real input events and read the value back. ' +
          'No CSS selector needed.',
        approval: true,
        approvalFor: requiresApproval,
        schema: S(
          {
            session_id: { type: 'string' },
            tab_id: { type: 'string' },
            text: { type: 'string' },
            clear: { type: 'boolean', description: 'clear the editor first (default true)' },
            submit: { type: 'boolean', description: 'press Enter afterwards' },
            expect: { type: 'object', description: 'condition to wait for afterwards (see chrome_wait_for)' },
          },
          ['text'],
        ),
        required: ['text'],
        handler: async (args, ctx) => {
          const session = needSession(args, ctx);
          const tab = await this._tab(session, args.tab_id);
          let res = await ctx.browser._fillEditor(session, tab, args);
          if (res.ok && args.submit) await ctx.browser._press(session, tab, 'Enter');
          if (args.submit) res = { ...res, submitted: true };
          return ctx.browser._withExpect(session, tab, args, res);
        },
      },
      {
        name: 'chrome_wait_for',
        description:
          'Wait until a page condition holds: {type: text_present|text_absent|element_present|element_absent|dialog_closed|composer_empty, text, role, name}. ' +
          'Returns ok=true with verified=true when it does, verified=false after the timeout. Read-only.',
        approval: false,
        schema: S(
          {
            session_id: { type: 'string' },
            tab_id: { type: 'string' },
            condition: { type: 'object' },
            timeout_sec: { type: 'number', description: 'default 15, max 120' },
          },
          ['condition'],
        ),
        required: ['condition'],
        handler: async (args, ctx) => {
          const session = needSession(args, ctx);
          const tab = await this._tab(session, args.tab_id);
          const started = Date.now();
          const verified = await ctx.browser._waitFor(session, tab, args.condition, args.timeout_sec || 15);
          return { ok: true, tab_id: tab.targetId, verified, condition: args.condition, elapsed_ms: Date.now() - started };
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
            ref: { type: 'string', description: 'element ref from chrome_observe' },
            snapshot_id: { type: 'string', description: 'snapshot_id from chrome_observe (detects stale refs)' },
            expect: { type: 'object', description: 'condition to wait for afterwards (see chrome_wait_for)' },
          },
          [],
        ),
        required: [],
        handler: async (args, ctx) => {
          const session = needSession(args, ctx);
          const tab = await this._tab(session, args.tab_id);
          if (args.ref) {
            const res = await ctx.browser._clickRef(session, tab, args);
            return ctx.browser._withExpect(session, tab, args, res);
          }
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
          const out = { ok: !!(res && res.clicked), tab_id: tab.targetId, ...(res || {}) };
          return ctx.browser._withExpect(session, tab, args, out);
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
            expect: { type: 'object', description: 'condition to wait for afterwards (see chrome_wait_for)' },
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
          const out = { ok: true, tab_id: tab.targetId, value: res.value, submitted: !!args.submit };
          return ctx.browser._withExpect(session, tab, args, out);
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
          'Capture a PNG screenshot of a tab. If "path" is given, the image is saved there (at the requested path) ' +
          'and the file can be read afterwards; otherwise the PNG is returned as base64.',
        approval: false,
        schema: S(
          {
            path: { type: 'string', description: 'where to save the PNG (must be at the requested path)' },
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
          if (ctx.artifact && b64) {
            ctx.artifact('screenshot', 'page.png', Buffer.from(b64, 'base64'), { source: 'chrome_screenshot' });
          }
          if (args.path) {
            const chk = checkPath(args.path, ctx.cfg, ctx.base, { write: true });
            if (!chk.ok) return { ok: false, error: chk.error, reason: chk.reason };
            fs.mkdirSync(path.dirname(chk.abs), { recursive: true });
            fs.writeFileSync(chk.abs, Buffer.from(b64, 'base64'));
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
