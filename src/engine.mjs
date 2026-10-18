import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { checkPath, resolveTarget, isInside } from './policy.mjs';
import { audit, saveArtifact, tailAudit, readArtifact, auditDir } from './audit.mjs';
import { requestApproval } from './approvals.mjs';
import { loadConfig, CONFIG_PATH } from './config.mjs';
import { BrowserManager } from './browser.mjs';
import { macTools } from './mac.mjs';
import { trustState, trustAllows } from './trust.mjs';
import { telegramTools } from './telegram.mjs';

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function clip(buf, cap) {
  if (buf.length <= cap) return { data: buf, truncated: false };
  return { data: buf.subarray(0, cap), truncated: true };
}

function runShell(command, { cwd, timeout, env, cap }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('/bin/sh', ['-lc', command], {
        cwd,
        env: { ...process.env, ...(env || {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ stdout: '', stderr: String(e.message), exit_code: -1, error: e.message });
      return;
    }
    const out = [];
    const err = [];
    let outLen = 0;
    let errLen = 0;
    let truncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, Math.max(1, timeout) * 1000);

    child.stdout.on('data', (c) => {
      if (outLen >= cap) {
        truncated = true;
        return;
      }
      const room = cap - outLen;
      const part = c.length > room ? c.subarray(0, room) : c;
      out.push(part);
      outLen += part.length;
      if (part.length < c.length) truncated = true;
    });
    child.stderr.on('data', (c) => {
      if (errLen >= cap) {
        truncated = true;
        return;
      }
      const room = cap - errLen;
      const part = c.length > room ? c.subarray(0, room) : c;
      err.push(part);
      errLen += part.length;
      if (part.length < c.length) truncated = true;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8') + String(e.message),
        exit_code: -1,
        error: e.message,
        truncated,
        timed_out: timedOut,
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        exit_code: code === null ? -1 : code,
        signal: signal || null,
        truncated,
        timed_out: timedOut,
      });
    });
  });
}

/* ------------------------------------------------------------------ *
 * tool catalog
 * ------------------------------------------------------------------ */

const S = (o) => ({ type: 'object', properties: o, required: [], additionalProperties: false });

export function toolCatalog() {
  return [
    {
      name: 'bash',
      description:
        'Run a shell command on the remote machine. Returns stdout, stderr and the exit code. ' +
        'Use absolute paths; the working directory defaults to the authorized root. This is a side-effecting operation and may require human approval.',
      approval: true,
      schema: S({
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Working directory (must be inside the authorized roots)' },
        timeout_sec: { type: 'number', description: 'Timeout in seconds (default 120, max 1800)' },
        env: { type: 'object', description: 'Extra environment variables' },
      }),
      required: ['command'],
      handler: async (args, ctx) => {
        const command = String(args.command ?? '');
        if (!command.trim()) return { ok: false, error: 'command is required' };
        if (!ctx.cfg.allowShell) return { ok: false, error: 'shell execution is disabled in the config' };
        const base = args.cwd ? resolveTarget(args.cwd, ctx.base) : ctx.base;
        const chk = checkPath(base, ctx.cfg, ctx.base);
        if (!chk.ok) return { ok: false, error: chk.error, reason: chk.reason };
        const timeout = Math.min(
          Number(args.timeout_sec || ctx.cfg.commandTimeoutSec || 120),
          1800,
        );
        const res = await runShell(command, {
          cwd: chk.abs,
          timeout,
          env: args.env || {},
          cap: ctx.cfg.maxOutputBytes,
        });
        return { ok: true, command, cwd: chk.abs, ...res };
      },
    },
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file from the remote machine.',
      approval: false,
      schema: S({
        path: { type: 'string', description: 'Absolute or root-relative file path' },
        max_bytes: { type: 'number', description: 'Maximum number of bytes to return' },
      }),
      required: ['path'],
      handler: async (args, ctx) => {
        const chk = checkPath(args.path, ctx.cfg, ctx.base);
        if (!chk.ok) return { ok: false, error: chk.error, reason: chk.reason };
        const stat = await fsp.stat(chk.abs).catch(() => null);
        if (!stat) return { ok: false, error: `not found: ${chk.abs}` };
        if (stat.isDirectory()) return { ok: false, error: `is a directory: ${chk.abs}` };
        const max = Math.min(
          Number(args.max_bytes || ctx.cfg.maxOutputBytes),
          ctx.cfg.maxOutputBytes,
        );
        const buf = await fsp.readFile(chk.abs);
        const c = clip(buf, max);
        return {
          ok: true,
          path: chk.abs,
          size: stat.size,
          truncated: c.truncated,
          content: c.data.toString('utf8'),
        };
      },
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a text file. May require human approval.',
      approval: true,
      schema: S({
        path: { type: 'string' },
        content: { type: 'string' },
        append: { type: 'boolean' },
      }),
      required: ['path', 'content'],
      handler: async (args, ctx) => {
        const chk = checkPath(args.path, ctx.cfg, ctx.base, { write: true });
        if (!chk.ok) return { ok: false, error: chk.error, reason: chk.reason };
        const content = String(args.content ?? '');
        if (Buffer.byteLength(content) > ctx.cfg.maxUploadBytes) {
          return { ok: false, error: 'content exceeds maxUploadBytes' };
        }
        await fsp.mkdir(path.dirname(chk.abs), { recursive: true });
        if (args.append) await fsp.appendFile(chk.abs, content);
        else await fsp.writeFile(chk.abs, content);
        return { ok: true, path: chk.abs, bytes: Buffer.byteLength(content), appended: !!args.append };
      },
    },
    {
      name: 'edit_file',
      description: 'Replace an exact string inside a file (old_text must appear exactly once unless replace_all is true).',
      approval: true,
      schema: S({
        path: { type: 'string' },
        old_text: { type: 'string' },
        new_text: { type: 'string' },
        replace_all: { type: 'boolean' },
      }),
      required: ['path', 'old_text', 'new_text'],
      handler: async (args, ctx) => {
        const chk = checkPath(args.path, ctx.cfg, ctx.base, { write: true });
        if (!chk.ok) return { ok: false, error: chk.error, reason: chk.reason };
        const oldText = String(args.old_text ?? '');
        if (!oldText) return { ok: false, error: 'old_text is required' };
        const buf = await fsp.readFile(chk.abs, 'utf8').catch(() => null);
        if (buf === null) return { ok: false, error: `not found: ${chk.abs}` };
        const count = buf.split(oldText).length - 1;
        if (count === 0) return { ok: false, error: 'old_text not found in file' };
        if (count > 1 && !args.replace_all) {
          return { ok: false, error: `old_text appears ${count} times, pass replace_all=true` };
        }
        const next = args.replace_all
          ? buf.split(oldText).join(String(args.new_text ?? ''))
          : buf.replace(oldText, String(args.new_text ?? ''));
        await fsp.writeFile(chk.abs, next);
        return { ok: true, path: chk.abs, replacements: args.replace_all ? count : 1 };
      },
    },
    {
      name: 'list_dir',
      description: 'List the contents of a directory on the remote machine.',
      approval: false,
      schema: S({
        path: { type: 'string', description: 'absolute path, "~" or "~/dir" allowed' },
        recursive: { type: 'boolean', description: 'walk into subdirectories (default false)' },
        depth: { type: 'number', description: 'how deep to walk when recursive is set (default 3)' },
        include_hidden: { type: 'boolean', description: 'include dotfiles (default true)' },
        max_entries: { type: 'number' },
      }),
      required: ['path'],
      handler: async (args, ctx) => {
        const chk = checkPath(args.path, ctx.cfg, ctx.base);
        if (!chk.ok) return { ok: false, error: chk.error, reason: chk.reason };
        const stat = await fsp.stat(chk.abs).catch(() => null);
        if (!stat) return { ok: false, error: `not found: ${chk.abs}` };
        if (!stat.isDirectory()) return { ok: false, error: `not a directory: ${chk.abs}` };
        const max = Math.min(Number(args.max_entries || 500), 20000);
        const depth = Math.max(0, Math.min(Number(args.depth ?? (args.recursive ? 3 : 0)), 8));
        const showHidden = args.include_hidden !== false;
        const entries = [];
        const errors = [];
        const walk = async (dir, level) => {
          if (entries.length >= max) return;
          let items;
          try {
            items = await fsp.readdir(dir, { withFileTypes: true });
          } catch (e) {
            errors.push({ path: dir, error: e.code || e.message });
            return;
          }
          for (const it of items) {
            if (entries.length >= max) return;
            if (!showHidden && it.name.startsWith('.')) continue;
            const full = path.join(dir, it.name);
            let size = null;
            let mtime = null;
            let type = 'file';
            try {
              // lstat never follows symlinks: a dead link cannot block the listing
              const st = await fsp.lstat(full);
              size = st.size;
              mtime = st.mtimeMs;
              type = st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'symlink' : 'file';
            } catch (e) {
              errors.push({ path: full, error: e.code || e.message });
              continue;
            }
            entries.push({ path: full, name: it.name, type, size, mtime, depth: level });
            if (level < depth && type === 'dir') await walk(full, level + 1);
          }
        };
        await walk(chk.abs, 0);
        return {
          ok: true,
          path: chk.abs,
          count: entries.length,
          depth,
          truncated: entries.length >= max,
          errors: errors.length ? errors : undefined,
          entries,
        };
      },
    },
    {
      name: 'search_files',
      description: 'Search for a text pattern in files under a directory (read-only).',
      approval: false,
      schema: S({
        path: { type: 'string' },
        query: { type: 'string' },
        regex: { type: 'boolean' },
        max_results: { type: 'number' },
        max_file_bytes: { type: 'number' },
      }),
      required: ['path', 'query'],
      handler: async (args, ctx) => {
        const chk = checkPath(args.path, ctx.cfg, ctx.base);
        if (!chk.ok) return { ok: false, error: chk.error, reason: chk.reason };
        const query = String(args.query ?? '');
        if (!query) return { ok: false, error: 'query is required' };
        const maxResults = Math.min(Number(args.max_results || 100), 5000);
        const maxFile = Math.min(Number(args.max_file_bytes || 2 * 1024 * 1024), ctx.cfg.maxOutputBytes);
        let matcher;
        if (args.regex) {
          try {
            matcher = new RegExp(query);
          } catch (e) {
            return { ok: false, error: `invalid regex: ${e.message}` };
          }
        } else {
          const needle = query.toLowerCase();
          matcher = { test: (s) => s.toLowerCase().includes(needle) };
        }
        const results = [];
        const skipDirs = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next']);
        const walk = async (dir) => {
          if (results.length >= maxResults) return;
          const items = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
          for (const it of items) {
            if (results.length >= maxResults) return;
            const full = path.join(dir, it.name);
            if (it.isDirectory()) {
              if (!skipDirs.has(it.name)) await walk(full);
              continue;
            }
            if (!it.isFile()) continue;
            const st = await fsp.stat(full).catch(() => null);
            if (!st || st.size > maxFile) continue;
            const text = await fsp.readFile(full, 'utf8').catch(() => null);
            if (text === null) continue;
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (matcher.test(lines[i])) {
                results.push({ path: full, line: i + 1, text: lines[i].slice(0, 500) });
                if (results.length >= maxResults) return;
              }
            }
          }
        };
        await walk(chk.abs);
        return { ok: true, path: chk.abs, count: results.length, results };
      },
    },
    {
      name: 'delete_path',
      description: 'Delete a file or directory (recursively) on the remote machine. Requires approval.',
      approval: true,
      schema: S({ path: { type: 'string' } }),
      required: ['path'],
      handler: async (args, ctx) => {
        const chk = checkPath(args.path, ctx.cfg, ctx.base, { write: true });
        if (!chk.ok) return { ok: false, error: chk.error, reason: chk.reason };
        if (isInside(chk.abs, ctx.base) && chk.abs === ctx.base) {
          return { ok: false, error: 'refusing to delete the working root' };
        }
        await fsp.rm(chk.abs, { recursive: true, force: true });
        return { ok: true, path: chk.abs, deleted: true };
      },
    },
    {
      name: 'file_get',
      description: 'Download a binary file as base64 (use for images, archives, binaries).',
      approval: false,
      schema: S({ path: { type: 'string' } }),
      required: ['path'],
      handler: async (args, ctx) => {
        const chk = checkPath(args.path, ctx.cfg, ctx.base);
        if (!chk.ok) return { ok: false, error: chk.error, reason: chk.reason };
        const st = await fsp.stat(chk.abs).catch(() => null);
        if (!st || !st.isFile()) return { ok: false, error: `not a file: ${chk.abs}` };
        if (st.size > ctx.cfg.maxUploadBytes) return { ok: false, error: 'file too large' };
        const buf = await fsp.readFile(chk.abs);
        return { ok: true, path: chk.abs, size: st.size, data_base64: buf.toString('base64') };
      },
    },
    {
      name: 'file_put',
      description: 'Upload a binary file (base64 payload). Requires approval.',
      approval: true,
      schema: S({ path: { type: 'string' }, data_base64: { type: 'string' } }),
      required: ['path', 'data_base64'],
      handler: async (args, ctx) => {
        const chk = checkPath(args.path, ctx.cfg, ctx.base, { write: true });
        if (!chk.ok) return { ok: false, error: chk.error, reason: chk.reason };
        const data = Buffer.from(String(args.data_base64 ?? ''), 'base64');
        if (data.length > ctx.cfg.maxUploadBytes) return { ok: false, error: 'payload too large' };
        await fsp.mkdir(path.dirname(chk.abs), { recursive: true });
        await fsp.writeFile(chk.abs, data);
        return { ok: true, path: chk.abs, bytes: data.length };
      },
    },
    {
      name: 'audit_log',
      description:
        'Read the detailed log of what happened on this machine: every tool call with its arguments, outcome and saved artifacts (screenshots, accessibility trees). Read-only.',
      approval: false,
      schema: S(
        {
          limit: { type: 'number', description: 'how many entries to return, default 30' },
          tool: { type: 'string', description: 'only entries of this tool' },
          since: { type: 'string', description: 'only entries newer than this ISO timestamp' },
        },
        [],
      ),
      required: [],
      handler: async (args) => {
        const n = Math.min(200, Number(args.limit) || 30);
        let entries = tailAudit(n * 4);
        if (args.tool) entries = entries.filter((e) => e.tool === args.tool);
        if (args.since) {
          const since = Date.parse(String(args.since));
          if (!Number.isNaN(since)) entries = entries.filter((e) => Date.parse(e.ts) >= since);
        }
        entries = entries.slice(-n);
        return { ok: true, count: entries.length, entries, artifacts_dir: auditDir() };
      },
    },
    {
      name: 'audit_artifact',
      description:
        'Fetch a saved artifact of a logged call: a screenshot (PNG as base64) or an accessibility tree (JSON). Read-only.',
      approval: false,
      schema: S(
        {
          entry: { type: 'string', description: 'entry id from audit_log' },
          file: { type: 'string', description: 'artifact file name, e.g. "screen.png" or "ax-tree.json"' },
        },
        ['entry', 'file'],
      ),
      required: ['entry', 'file'],
      handler: async (args) => {
        const art = readArtifact(args.entry, args.file);
        if (!art) {
          return { ok: false, error: 'artifact_not_found', hint: 'Run audit_log to see the available artifacts.' };
        }
        if (/\.(png|jpe?g)$/i.test(art.file)) {
          return { ok: true, kind: 'image', file: art.file, bytes: art.data.length, image_base64: art.data.toString('base64') };
        }
        const text = art.data.toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not json */
        }
        return { ok: true, kind: json ? 'json' : 'text', file: art.file, bytes: art.data.length, content: json ?? text.slice(0, 200000) };
      },
    },
    {
      name: 'sysinfo',
      description: 'Read-only information about the remote machine: OS, user, uptime, memory, disks, network interfaces.',
      approval: false,
      schema: S({}),
      required: [],
      handler: async (_args, ctx) => {
        const net = {};
        for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
          net[name] = (addrs || []).map((a) => `${a.family}:${a.address}${a.internal ? ' (internal)' : ''}`);
        }
        return {
          ok: true,
          hostname: os.hostname(),
          platform: os.platform(),
          release: os.release(),
          arch: os.arch(),
          user: os.userInfo().username,
          home: os.homedir(),
          cwd: ctx.base,
          uptime_sec: Math.round(os.uptime()),
          loadavg: os.loadavg(),
          totalmem: os.totalmem(),
          freemem: os.freemem(),
          cpus: os.cpus().length,
          node: process.version,
          network: net,
        };
      },
    },
    {
      name: 'start_process',
      description:
        'Start a long-running background process (dev server, watcher, REPL). Returns a session_id to poll with read_process_output.',
      approval: true,
      schema: S({
        command: { type: 'string' },
        cwd: { type: 'string' },
      }),
      required: ['command'],
      handler: async (args, ctx) => {
        const command = String(args.command ?? '');
        if (!command.trim()) return { ok: false, error: 'command is required' };
        const base = args.cwd ? resolveTarget(args.cwd, ctx.base) : ctx.base;
        const chk = checkPath(base, ctx.cfg, ctx.base);
        if (!chk.ok) return { ok: false, error: chk.error, reason: chk.reason };
        const child = spawn('/bin/sh', ['-lc', command], {
          cwd: chk.abs,
          env: process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const sessionId = `proc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const session = {
          id: sessionId,
          child,
          command,
          cwd: chk.abs,
          out: [],
          err: [],
          outLen: 0,
          errLen: 0,
          cap: ctx.cfg.maxOutputBytes,
          startedAt: Date.now(),
          exited: false,
          exitCode: null,
        };
        const cap = session.cap;
        child.stdout.on('data', (c) => {
          if (session.outLen >= cap) return;
          const room = cap - session.outLen;
          const part = c.length > room ? c.subarray(0, room) : c;
          session.out.push(part);
          session.outLen += part.length;
        });
        child.stderr.on('data', (c) => {
          if (session.errLen >= cap) return;
          const room = cap - session.errLen;
          const part = c.length > room ? c.subarray(0, room) : c;
          session.err.push(part);
          session.errLen += part.length;
        });
        child.on('close', (code) => {
          session.exited = true;
          session.exitCode = code;
        });
        ctx.sessions.set(sessionId, session);
        return { ok: true, session_id: sessionId, pid: child.pid, command, cwd: chk.abs };
      },
    },
    {
      name: 'read_process_output',
      description: 'Read output of a process started with start_process. Waits up to timeout_sec for new output.',
      approval: false,
      schema: S({
        session_id: { type: 'string' },
        timeout_sec: { type: 'number' },
        drain: { type: 'boolean' },
      }),
      required: ['session_id'],
      handler: async (args, ctx) => {
        const s = ctx.sessions.get(String(args.session_id ?? ''));
        if (!s) return { ok: false, error: `unknown session: ${args.session_id}` };
        const wait = Math.min(Number(args.timeout_sec || 0), 120);
        const deadline = Date.now() + wait * 1000;
        while (!s.exited && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
        }
        const stdout = Buffer.concat(s.out).toString('utf8');
        const stderr = Buffer.concat(s.err).toString('utf8');
        if (args.drain) {
          s.out = [];
          s.err = [];
          s.outLen = 0;
          s.errLen = 0;
        }
        return {
          ok: true,
          session_id: s.id,
          running: !s.exited,
          exit_code: s.exitCode,
          stdout,
          stderr,
          uptime_sec: Math.round((Date.now() - s.startedAt) / 1000),
        };
      },
    },
    {
      name: 'write_process',
      description: 'Send input to a running process session (stdin).',
      approval: false,
      schema: S({
        session_id: { type: 'string' },
        input: { type: 'string' },
      }),
      required: ['session_id', 'input'],
      handler: async (args, ctx) => {
        const s = ctx.sessions.get(String(args.session_id ?? ''));
        if (!s) return { ok: false, error: `unknown session: ${args.session_id}` };
        if (s.exited) return { ok: false, error: 'process already exited' };
        s.child.stdin.write(String(args.input ?? ''));
        return { ok: true, session_id: s.id, written: String(args.input ?? '').length };
      },
    },
    {
      name: 'kill_process',
      description: 'Terminate a running process session. Requires approval.',
      approval: true,
      schema: S({
        session_id: { type: 'string' },
        signal: { type: 'string', description: 'SIGTERM (default) or SIGKILL' },
      }),
      required: ['session_id'],
      handler: async (args, ctx) => {
        const s = ctx.sessions.get(String(args.session_id ?? ''));
        if (!s) return { ok: false, error: `unknown session: ${args.session_id}` };
        const signal = args.signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM';
        try {
          s.child.kill(signal);
        } catch (e) {
          return { ok: false, error: e.message };
        }
        return { ok: true, session_id: s.id, signal, killed: true };
      },
    },
  ];
}

/* ------------------------------------------------------------------ *
 * engine
 * ------------------------------------------------------------------ */

export class Engine {
  constructor(cfg, { base } = {}) {
    this.cfg = cfg;
    this.base = base || process.cwd();
    this.sessions = new Map();
    this.browser = new BrowserManager(cfg);
  }

  catalog() {
    return [...toolCatalog(), ...this.browser.tools(), ...macTools(this.cfg), ...telegramTools(this.cfg)];
  }

  async call(name, args = {}, { requireApproval } = {}) {
    try {
      if (fs.existsSync(CONFIG_PATH)) this.cfg = loadConfig();
    } catch {
      /* keep the last valid snapshot */
    }
    const tool = this.catalog().find((t) => t.name === name);
    if (!tool) return { ok: false, error: `unknown tool: ${name}` };
    const started = Date.now();
    let approval = null;
    const entryId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(name).replace(/[^\w.-]/g, '_')}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const ctx = Object.create(this);
    ctx.entryId = entryId;
    ctx.artifacts = [];
    ctx.artifact = (kind, file, data, meta) => {
      const saved = saveArtifact(entryId, kind, file, data, meta);
      if (saved) ctx.artifacts.push(saved);
      return saved;
    };

    let needApproval = tool.approvalFor ? !!tool.approvalFor(args, this) : !!tool.approval;
    if (this.cfg.requireApproval === false) needApproval = false;
    if (requireApproval === true) needApproval = true;
    else if (requireApproval === false) needApproval = false;

    if (needApproval) {
      const trust = trustState();
      if (trustAllows(trust, tool.name, args, this.cfg)) {
        if (this.cfg.audit !== false) {
          audit({ id: entryId, tool: tool.name, args, status: 'ok', via: 'trust_window' });
        }
        const res = await tool.handler(args, ctx);
        return res;
      }
      approval = await requestApproval(tool.name, args, this.cfg);
      if (!approval.approved) {
        const status = approval.rec?.status || 'denied';
        if (this.cfg.audit !== false) {
          audit({ id: entryId, tool: tool.name, args, status: 'approval_denied', approval_status: status });
        }
        const pending = status === 'pending' || status === 'timeout' || status === 'expired';
        return {
          ok: false,
          error: pending ? 'APPROVAL_PENDING' : 'APPROVAL_DENIED',
          status,
          pending,
          reason: pending
            ? `approval wait ended (${status}) for tool "${tool.name}"; this request is closed`
            : `human ${status} tool "${tool.name}"`,
          approval_id: approval.rec?.id || null,
          hint: pending
            ? 'This approval_id is closed and cannot be approved. Ask the user to open a trust window: arena-bridge trust --for 1h. Then retry the call once, or arrange a fresh call for approval while it is waiting.'
            : 'The user declined this action. Do not retry it; ask what to do instead.',
        };
      }
    }

    try {
      const res = await tool.handler(args, ctx);
      if (this.cfg.audit !== false) {
        audit({
          id: entryId,
          tool: tool.name,
          args,
          status: res.ok ? 'ok' : 'error',
          duration_ms: Date.now() - started,
          exit_code: res.exit_code,
          error: res.ok ? undefined : res.error,
          artifacts: ctx.artifacts.length ? ctx.artifacts : undefined,
        });
      }
      return res;
    } catch (e) {
      if (this.cfg.audit !== false) {
        audit({
          id: entryId,
          tool: tool.name,
          args,
          status: 'exception',
          duration_ms: Date.now() - started,
          error: e.message,
          artifacts: ctx.artifacts.length ? ctx.artifacts : undefined,
        });
      }
      return { ok: false, error: e.message };
    }
  }

  /** Full MCP-style tool description list. */
  mcpTools() {
    return this.catalog().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: {
        type: 'object',
        properties: t.schema.properties || {},
        required: t.required || [],
        additionalProperties: false,
      },
    }));
  }
}
