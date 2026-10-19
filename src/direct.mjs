import http from 'node:http';
import { VERSION } from './version.mjs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sendJson, sendText, sendRaw, readJson, readBody, isAuthorized, bearer, safeEqual } from './http.mjs';
import { handleMcp } from './mcp.mjs';
import { buildPrompt } from './prompt.mjs';
import { listApprovals, decide, settle } from './approvals.mjs';
import { checkPath } from './policy.mjs';
import { loadConfig } from './config.mjs';
import { tailAudit, readArtifact, auditDir, audit } from './audit.mjs';
import { describeSource, sourceOf, admitUnauthorized } from './source.mjs';
import { errorResponse } from './errors.mjs';
import { startPoller, parseCommand, sendTelegram, answerCallback, editMessageText } from './telegram.mjs';

export function createDirectServer(cfg, engine) {
  const mcpCtx = {
    cfg,
    listTools: () => engine.mcpTools(),
    callTool: (name, args) => engine.call(name, args),
  };

  const handleTelegramMessage = async (item) => {
    const cmd = parseCommand(item.text);
    if (!cmd) return;
    const current = loadConfig();
    const say = (text) => sendTelegram(current, { text, chatId: item.chat_id });
    if ((cmd.cmd === 'approve' || cmd.cmd === 'deny') && cmd.args) {
      const res = decide(cmd.args, cmd.cmd === 'approve' ? 'approve' : 'deny', 'telegram');
      await say(res.ok ? `${cmd.cmd === 'approve' ? 'Approved' : 'Denied'} ${cmd.args}` : `Cannot ${cmd.cmd}: ${res.error}`);
      return;
    }
    if (cmd.cmd === 'status') {
      const pending = listApprovals().filter((a) => a.status === 'pending').length;
      await say(`arena-bridge on ${cfg.device}\nPending approvals: ${pending}`);
      return;
    }
    if (cmd.cmd === 'help') {
      await say('Commands: /approve <id>, /deny <id>, /status');
      return;
    }
  };

  const handleTelegramCallback = async (cb) => {
    const current = loadConfig();
    const [action, id] = String(cb.data || '').split(':');
    if (!id || !['approve', 'approve3h', 'deny'].includes(action)) {
      await answerCallback(current, cb.callback_id, 'Unknown action');
      return;
    }
    const trustSec = action === 'approve3h' ? 3 * 3600 : 0;
    const res = settle(id, action === 'deny' ? 'deny' : 'approve', 'telegram', { trustSec });
    const tool = res.approval?.tool || 'the tool';
    const text = !res.ok
      ? `Cannot ${action}: ${res.error || 'unknown error'}`
      : action === 'deny'
        ? `Denied ${id}`
        : trustSec
          ? `Approved ${id} — ${tool} is trusted for the next 3 hours`
          : `Approved ${id}`;
    await answerCallback(current, cb.callback_id, res.ok ? 'Done' : 'Error');
    await editMessageText(current, { chatId: cb.chat_id, messageId: cb.message_id, text });
  };

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad request url' });
    }
    const p = url.pathname;

    try {
      if (p === '/health') {
        const expose = cfg.exposeDeviceInHealth !== false;
        let pending = 0, trustActive = false, auditCount = 0, logSize = 0;
        try { pending = listApprovals().filter(a => a.status === 'pending').length; } catch {}
        try { const { trustState } = await import('./trust.mjs'); trustActive = !!trustState().active; } catch {}
        try { const { tailAudit } = await import('./audit.mjs'); auditCount = tailAudit(500).length; } catch {}
        try { const fs2 = await import('node:fs'); const p2 = path.join(CONFIG_DIR, 'logs', 'bridge.log'); if (fs2.existsSync(p2)) logSize = fs2.statSync(p2).size; } catch {}
        return sendJson(res, 200, {
          ok: true,
          mode: 'direct',
          ...(expose ? { device: cfg.device } : {}),
          version: VERSION,
          uptime_sec: Math.round(process.uptime()),
          pending_approvals: pending,
          trust_active: trustActive,
          audit_count: auditCount,
          log_size: logSize,
          has_public_url: !!cfg.publicUrl,
        });
      }

      // Re-read once per request so auth, policy, limits and the response agree.
      const cfgNow = loadConfig();
      mcpCtx.cfg = cfgNow;
      if (!isAuthorized(req, cfgNow)) {
        const source = describeSource(req, 'http');
        const seen = admitUnauthorized(source.ip);
        if (seen.previousSuppressed) {
          audit({ kind: 'auth', tool: null, status: 'unauthorized', error: 'UNAUTHORIZED', via: 'direct', actor: 'system', source, args: { path: p, suppressed: seen.previousSuppressed } });
        }
        if (seen.write) {
          audit({ kind: 'auth', tool: null, status: 'unauthorized', error: 'UNAUTHORIZED', via: 'direct', actor: 'system', source, args: { path: p, method: req.method, count_in_minute: seen.count } });
        }
        res.setHeader('www-authenticate', 'Bearer');
        return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      }

      if (req.method === 'GET' && p === '/tools') {
        return sendJson(res, 200, { ok: true, tools: engine.mcpTools() });
      }

      if (req.method === 'GET' && p === '/prompt') {
        const text = buildPrompt(cfgNow, { tool: engine, baseUrl: url.searchParams.get('base') || undefined });
        return sendText(res, 200, text);
      }

      if (req.method === 'GET' && p === '/config') {
        return sendJson(res, 200, {
          ok: true,
          device: cfgNow.device,
          roots: cfgNow.roots,
          protected_count: cfgNow.protected.length,
          requireApproval: cfgNow.requireApproval,
          allowShell: cfgNow.allowShell,
          approvalWaitSec: cfgNow.approvalWaitSec,
          maxOutputBytes: cfgNow.maxOutputBytes,
          telegram: {
            enabled: !!cfgNow.telegram?.enabled,
            chat_ids: cfgNow.telegram?.chatIds || [],
          },
        });
      }

      if (req.method === 'GET' && p === '/audit') {
        const raw = url.searchParams.get('limit');
        let limit = 30;
        if (raw !== null && raw !== '') {
          const parsed = Number(raw);
          if (!Number.isFinite(parsed) || parsed <= 0) return sendJson(res, 400, { ok: false, error: 'invalid limit' });
          limit = Math.min(200, Math.floor(parsed));
        }
        return sendJson(res, 200, { ok: true, entries: tailAudit(limit), artifacts_dir: auditDir() });
      }

      if (req.method === 'GET' && p === '/audit/artifact') {
        const entry = url.searchParams.get('entry');
        const file = url.searchParams.get('file');
        if (!entry || !file) {
          return sendJson(res, 400, { ok: false, error: 'entry and file query parameters are required' });
        }
        const art = readArtifact(entry, file);
        if (!art) return sendJson(res, 404, { ok: false, error: 'artifact_not_found' });
        const type = /\.png$/i.test(art.file)
          ? 'image/png'
          : /\.jpe?g$/i.test(art.file)
            ? 'image/jpeg'
            : /\.json$/i.test(art.file)
              ? 'application/json; charset=utf-8'
              : 'text/plain; charset=utf-8';
        return sendRaw(res, 200, art.data, type);
      }

      if (req.method === 'GET' && p === '/approvals') {
        return sendJson(res, 200, { ok: true, approvals: listApprovals() });
      }
      // R5: poll single approval — GET /approvals/:id (idempotent, no body)
      const getApproveMatch = /^\/approvals\/([\w-]+)$/.exec(p);
      if (req.method === 'GET' && getApproveMatch) {
        const found = listApprovals().find(a => a.id === getApproveMatch[1]);
        if (!found) return sendJson(res, 404, { ok: false, error: 'approval_not_found' });
        return sendJson(res, 200, { ok: true, approval: found });
      }

      const approveMatch = /^\/approvals\/([\w-]+)$/.exec(p);
      if (req.method === 'POST' && approveMatch) {
        // settling a request is a local-only privilege: the agent token must not self-approve
        const expected = loadConfig().localToken;
        const presented = bearer(req);
        if (!expected || !presented || !safeEqual(presented, expected)) {
          audit({ kind: 'approval', tool: null, status: 'forbidden', error: 'FORBIDDEN', via: 'api', actor: 'agent', source: await sourceOf(req, 'http'), args: { approval_id: approveMatch[1] } });
          return sendJson(res, 403, {
            ok: false,
            error: 'forbidden',
            reason: 'approvals require the local token — run "arena-bridge approve <id>" on the machine',
          });
        }
        const body = await readJson(req, 64 * 1024);
        const decision = body.decision === 'deny' ? 'deny' : 'approve';
        const res2 = decide(approveMatch[1], decision, 'api');
        return sendJson(res, res2.ok ? 200 : 400, res2);
      }

      if (req.method === 'POST' && p === '/exec') {
        const body = await readJson(req, cfgNow.maxUploadBytes);
        const source = await sourceOf(req, 'http');
        const result = await engine.call('bash', {
          command: body.command,
          cwd: body.cwd,
          timeout_sec: body.timeout_sec,
          env: body.env,
        }, { source });
        const status = result.ok ? 200 : (result.error === 'APPROVAL_PENDING' ? 202 : 400);
        return sendJson(res, status, result);
      }

      if (req.method === 'POST' && p === '/call') {
        const body = await readJson(req, cfgNow.maxUploadBytes);
        const source = await sourceOf(req, 'http');
        if (!body.tool) {
          audit({ kind: 'call', tool: null, status: 'rejected', error: 'INVALID_ARGS', via: 'direct', source, args: {} });
          return sendJson(res, 400, { ok: false, error: 'tool is required' });
        }
        const result = await engine.call(String(body.tool), body.args || {}, { source });
        // R5: return 202 for pending approvals, so client can poll GET /approvals/:id
        const status = result.ok ? 200 : (result.error === 'APPROVAL_PENDING' ? 202 : 400);
        return sendJson(res, status, result);
      }

      if (p === '/files') {
        const target = url.searchParams.get('path');
        const source = await sourceOf(req, 'http');
        const toolName = req.method === 'GET' ? 'file_get' : req.method === 'DELETE' ? 'delete_path' : 'file_put';
        if (!target) return sendJson(res, 400, { ok: false, error: 'path query parameter is required' });
        const chk = checkPath(target, cfgNow, engine.base, { write: req.method !== 'GET' });
        if (!chk.ok) {
          audit({ tool: toolName, args: { path: target }, status: 'error', error: chk.error, via: 'files_api', source });
          return sendJson(res, 403, { ok: false, error: chk.error, reason: chk.reason });
        }
        // PUT/DELETE must go through the approval gate and audit, like the tools
        if (req.method !== 'GET') {
          const { authorize } = await import('./gate.mjs');
          const resAuth = await authorize(toolName, { path: target }, cfgNow, source);
          if (!resAuth.ok) {
            const status = resAuth.status || 'denied';
            const pending = resAuth.pending;
            return sendJson(res, pending ? 202 : 403, {
              ok: false,
              error: pending ? 'APPROVAL_PENDING' : 'APPROVAL_DENIED',
              status,
              approval_id: resAuth.approval_id || null,
            });
          }
        }
        try {
          if (req.method === 'GET') {
            const buf = await fsp.readFile(chk.abs);
            audit({ tool: 'file_get', args: { path: target }, status: 'ok', via: 'files_api', source, bytes: buf.length });
            return sendRaw(res, 200, buf);
          }
          if (req.method === 'PUT' || req.method === 'POST') {
            const buf = await readBody(req, cfgNow.maxUploadBytes);
            await fsp.mkdir(path.dirname(chk.abs), { recursive: true });
            await fsp.writeFile(chk.abs, buf);
            audit({ tool: 'file_put', args: { path: target }, status: 'ok', via: 'files_api', source, bytes: buf.length });
            return sendJson(res, 200, { ok: true, path: chk.abs, bytes: buf.length });
          }
          if (req.method === 'DELETE') {
            await fsp.rm(chk.abs, { recursive: true, force: true });
            audit({ tool: 'delete_path', args: { path: target }, status: 'ok', via: 'files_api', source });
            return sendJson(res, 200, { ok: true, path: chk.abs, deleted: true });
          }
        } catch (e) {
          audit({ tool: toolName, args: { path: target }, status: 'error', error: e.message, via: 'files_api', source });
          return sendJson(res, 400, { ok: false, error: e.message });
        }
        return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      }

      if (p === '/v1/events') {
        // SSE: stream approvals/audit/health deltas; no auth? require auth
        // (use same auth as other endpoints)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(': arena-bridge events\n\n');
        let closed=false;
        res.on('close', ()=>{ closed=true; });
        req.on('close', ()=>{ closed=true; });
        const send = (event, data) => {
          if (closed) return;
          try { res.write(`event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`); } catch {}
        };
        // initial snapshot
        try {
          const pending = listApprovals().filter(a=>a.status==='pending');
          send('approvals', { pending: pending.length, approvals: pending.slice(0,10) });
        } catch {}
        try { const { tailAudit } = await import('./audit.mjs'); send('audit', { entries: tailAudit(5) }); } catch {}
        send('hello', { version: VERSION, time: new Date().toISOString() });
        const interval = setInterval(async ()=>{
          if (closed) { clearInterval(interval); return; }
          try {
            const pending = listApprovals().filter(a=>a.status==='pending');
            // simple: send heartbeat + counts every tick; client can diff
            send('heartbeat', { ts: Date.now(), pending_approvals: pending.length });
          } catch {}
        }, 3000);
        // keep open; do not end response
        return;
      }

      if (p === '/mcp') {
        if (req.method !== 'POST') {
          return sendJson(res, 405, { ok: false, error: 'method not allowed', hint: 'use POST /mcp' });
        }
        const source = await sourceOf(req, 'mcp');
        return handleMcp(req, res, { ...mcpCtx, callTool: (name, args) => engine.call(name, args, { source }) });
      }

      return sendJson(res, 404, { ok: false, error: `no route for ${req.method} ${p}` });
    } catch (e) {
      const code = /invalid JSON/.test(e.message) ? 'INVALID_JSON' : /too large/.test(e.message) ? 'PAYLOAD_TOO_LARGE' : null;
      if (!code) return sendJson(res, 500, { ok: false, error: e.message });
      if (p === '/call' || p === '/exec') {
        audit({ kind: 'call', tool: null, status: 'rejected', error: code, via: 'direct', source: describeSource(req, 'http'), args: {} });
      }
      return sendJson(res, code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, errorResponse(code));
    }
  });

  const poller = startPoller(cfg, { onMessage: handleTelegramMessage, onCallback: handleTelegramCallback });
  server.on('close', () => poller?.stop());

  return server;
}