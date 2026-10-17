import http from 'node:http';
import fsp from 'node:fs/promises';
import { sendJson, sendText, sendRaw, readJson, readBody, isAuthorized, bearer, safeEqual } from './http.mjs';
import { handleMcp } from './mcp.mjs';
import { buildPrompt } from './prompt.mjs';
import { listApprovals, decide } from './approvals.mjs';
import { checkPath } from './policy.mjs';
import { loadConfig } from './config.mjs';

export function createDirectServer(cfg, engine) {
  const mcpCtx = {
    cfg,
    listTools: () => engine.mcpTools(),
    callTool: (name, args) => engine.call(name, args),
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
          version: '0.6.5',
          uptime_sec: Math.round(process.uptime()),
        });
      }

      // re-read the config per request so a rotated token takes effect without a restart
      if (!isAuthorized(req, loadConfig())) {
        res.setHeader('www-authenticate', 'Bearer');
        return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      }

      if (req.method === 'GET' && p === '/tools') {
        return sendJson(res, 200, { ok: true, tools: engine.mcpTools() });
      }

      if (req.method === 'GET' && p === '/prompt') {
        const text = buildPrompt(cfg, { tool: engine, baseUrl: url.searchParams.get('base') || undefined });
        return sendText(res, 200, text);
      }

      if (req.method === 'GET' && p === '/config') {
        return sendJson(res, 200, {
          ok: true,
          device: cfg.device,
          roots: cfg.roots,
          protected_count: cfg.protected.length,
          requireApproval: cfg.requireApproval,
          allowShell: cfg.allowShell,
          approvalWaitSec: cfg.approvalWaitSec,
          maxOutputBytes: cfg.maxOutputBytes,
        });
      }

      if (req.method === 'GET' && p === '/approvals') {
        return sendJson(res, 200, { ok: true, approvals: listApprovals() });
      }

      const approveMatch = /^\/approvals\/([\w-]+)$/.exec(p);
      if (req.method === 'POST' && approveMatch) {
        const body = await readJson(req, 64 * 1024);
        const decision = body.decision === 'deny' ? 'deny' : 'approve';
        const res2 = decide(approveMatch[1], decision, 'api');
        return sendJson(res2.ok ? 200 : 400, res2);
      }

      if (req.method === 'POST' && p === '/exec') {
        const body = await readJson(req, cfg.maxUploadBytes);
        const result = await engine.call('bash', {
          command: body.command,
          cwd: body.cwd,
          timeout_sec: body.timeout_sec,
          env: body.env,
        });
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (req.method === 'POST' && p === '/call') {
        const body = await readJson(req, cfg.maxUploadBytes);
        if (!body.tool) return sendJson(res, 400, { ok: false, error: 'tool is required' });
        const result = await engine.call(String(body.tool), body.args || {});
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (p === '/files') {
        const target = url.searchParams.get('path');
        if (!target) return sendJson(res, 400, { ok: false, error: 'path query parameter is required' });
        const chk = checkPath(target, cfg, engine.base, { write: req.method !== 'GET' });
        if (!chk.ok) return sendJson(res, 403, { ok: false, error: chk.error, reason: chk.reason });
        try {
          if (req.method === 'GET') {
            const buf = await fsp.readFile(chk.abs);
            return sendRaw(res, 200, buf);
          }
          if (req.method === 'PUT' || req.method === 'POST') {
            const buf = await readBody(req, cfg.maxUploadBytes);
            await fsp.mkdir(chk.abs.replace(/\/[^/]*$/, ''), { recursive: true });
            await fsp.writeFile(chk.abs, buf);
            return sendJson(res, 200, { ok: true, path: chk.abs, bytes: buf.length });
          }
          if (req.method === 'DELETE') {
            await fsp.rm(chk.abs, { recursive: true, force: true });
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

  return server;
}
