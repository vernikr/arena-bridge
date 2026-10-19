import http from 'node:http';
import fsp from 'node:fs/promises';
import { sendJson, sendText, sendRaw, readJson, readBody, isAuthorized, bearer, safeEqual } from './http.mjs';
import { handleMcp } from './mcp.mjs';
import { buildPrompt } from './prompt.mjs';
import { listApprovals, decide, settle } from './approvals.mjs';
import { checkPath } from './policy.mjs';
import { loadConfig } from './config.mjs';
import { tailAudit, readArtifact, auditDir } from './audit.mjs';
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
        return sendJson(res, 200, {
          ok: true,
          mode: 'direct',
          device: cfg.device,
          version: '0.8.1',
          uptime_sec: Math.round(process.uptime()),
        });
      }

      // Re-read once per request so auth, policy, limits and the response agree.
      const cfgNow = loadConfig();
      mcpCtx.cfg = cfgNow;
      if (!isAuthorized(req, cfgNow)) {
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
        let limit = Number(url.searchParams.get('limit'));
        if (!Number.isFinite(limit) || limit <= 0) limit = 30;
        else limit = Math.min(200, Math.floor(limit));
        if (Number.isNaN(limit)) return sendJson(res, 400, { ok: false, error: 'invalid limit' });
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

      const approveMatch = /^\/approvals\/([\w-]+)$/.exec(p);
      if (req.method === 'POST' && approveMatch) {
        // settling a request is a local-only privilege: the agent token must not self-approve
        const expected = loadConfig().localToken;
        const presented = bearer(req);
        if (!expected || !presented || !safeEqual(presented, expected)) {
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
        const result = await engine.call('bash', {
          command: body.command,
          cwd: body.cwd,
          timeout_sec: body.timeout_sec,
          env: body.env,
        });
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (req.method === 'POST' && p === '/call') {
        const body = await readJson(req, cfgNow.maxUploadBytes);
        if (!body.tool) return sendJson(res, 400, { ok: false, error: 'tool is required' });
        const result = await engine.call(String(body.tool), body.args || {});
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (p === '/files') {
        const target = url.searchParams.get('path');
        if (!target) return sendJson(res, 400, { ok: false, error: 'path query parameter is required' });
        const chk = checkPath(target, cfgNow, engine.base, { write: req.method !== 'GET' });
        if (!chk.ok) return sendJson(res, 403, { ok: false, error: chk.error, reason: chk.reason });
        // PUT/DELETE must go through the approval gate and audit, like the tools
        if (req.method !== 'GET') {
          const toolName = req.method === 'DELETE' ? 'delete_path' : 'file_put';
          const { trustState, trustAllows } = await import('./trust.mjs');
          const { requestApproval } = await import('./approvals.mjs');
          const { audit } = await import('./audit.mjs');
          const trust = trustState();
          let needApproval = true;
          if (trustAllows(trust, toolName, { path: target }, cfgNow)) {
            needApproval = false;
          } else if (cfgNow.requireApproval === false) {
            needApproval = false;
          }
          if (needApproval) {
            const approval = await requestApproval(toolName, { path: target }, cfgNow);
            if (!approval.approved) {
              const status = approval.rec?.status || 'denied';
              audit({ tool: toolName, args: { path: target }, status: 'approval_denied', approval_status: status });
              const pending = status === 'pending' || status === 'timeout' || status === 'expired';
              return sendJson(res, pending ? 202 : 403, {
                ok: false,
                error: pending ? 'APPROVAL_PENDING' : 'APPROVAL_DENIED',
                status,
                approval_id: approval.rec?.id || null,
              });
            }
          }
        }
        try {
          if (req.method === 'GET') {
            const buf = await fsp.readFile(chk.abs);
            return sendRaw(res, 200, buf);
          }
          if (req.method === 'PUT' || req.method === 'POST') {
            const buf = await readBody(req, cfgNow.maxUploadBytes);
            await fsp.mkdir(path.dirname(chk.abs), { recursive: true });
            await fsp.writeFile(chk.abs, buf);
            try { const { audit } = await import('./audit.mjs'); audit({ tool: 'file_put', args: { path: target }, status: 'ok', via: 'files_api' }); } catch {}
            return sendJson(res, 200, { ok: true, path: chk.abs, bytes: buf.length });
          }
          if (req.method === 'DELETE') {
            await fsp.rm(chk.abs, { recursive: true, force: true });
            try { const { audit } = await import('./audit.mjs'); audit({ tool: 'delete_path', args: { path: target }, status: 'ok', via: 'files_api' }); } catch {}
            return sendJson(res, 200, { ok: true, path: chk.abs, deleted: true });
          }
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: e.message });
        }
        return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      }

      if (req.method === 'POST' && p === '/mcp') {
        return handleMcp(req, res, mcpCtx);
      }

      return sendJson(res, 404, { ok: false, error: `no route for ${req.method} ${p}` });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  });

  const poller = startPoller(cfg, { onMessage: handleTelegramMessage, onCallback: handleTelegramCallback });
  server.on('close', () => poller?.stop());

  return server;
}
