import http from 'node:http';
import crypto from 'node:crypto';
import { sendJson, sendText, readJson, readBody, isAuthorized, safeEqual } from './http.mjs';
import { handleMcp } from './mcp.mjs';
import { buildPrompt } from './prompt.mjs';
import { toolCatalog } from './engine.mjs';
import { listApprovals, decide } from './approvals.mjs';
import { checkPath } from './policy.mjs';
import { loadConfig } from './config.mjs';
import fsp from 'node:fs/promises';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function deviceTokens(cfg) {
  const list = [];
  if (cfg.deviceToken) list.push(cfg.deviceToken);
  for (const t of Object.values(cfg.deviceTokens || {})) list.push(t);
  return list;
}

function isDeviceAuthorized(req, cfg) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  if (!m) return false;
  const token = m[1].trim();
  return deviceTokens(cfg).some((t) => safeEqual(token, t));
}

export function createHubServer(cfg) {
  const devices = new Map(); // name -> { lastSeen }
  const queues = new Map(); // name -> [{id, tool, args}]
  const jobs = new Map(); // id -> { resolve, timer }

  const dispatch = (device, tool, args, timeoutSec = 120) =>
    new Promise((resolve) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        jobs.delete(id);
        resolve({
          ok: false,
          error: 'TIMEOUT',
          reason: `device "${device}" did not answer within ${timeoutSec}s`,
        });
      }, (timeoutSec + 15) * 1000);
      jobs.set(id, { resolve, timer });
      const q = queues.get(device) || [];
      q.push({ id, tool, args });
      queues.set(device, q);
    });

  const callTool = async (tool, args) => {
    const device = args?.device || cfg.device;
    if (!device) return { ok: false, error: 'no target device specified' };
    const known = devices.get(device);
    if (!known || Date.now() - known.lastSeen > 60_000) {
      return { ok: false, error: 'DEVICE_OFFLINE', reason: `device "${device}" is not connected` };
    }
    const clean = { ...args };
    delete clean.device;
    return dispatch(device, tool, clean, Number(args?.timeout_sec || 120));
  };

  const mcpCtx = {
    cfg,
    listTools: () =>
      toolCatalog().map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: {
          type: 'object',
          properties: t.schema.properties || {},
          required: t.required || [],
          additionalProperties: false,
        },
      })),
    callTool: (name, args) => callTool(name, args),
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
          mode: 'hub',
          version: '0.6.7',
          devices: [...devices.keys()],
        });
      }

      /* ---------- device side (device token) ---------- */
      if (p.startsWith('/device/')) {
        if (!isDeviceAuthorized(req, cfg)) {
          return sendJson(res, 401, { ok: false, error: 'unauthorized device' });
        }
        if (req.method === 'POST' && p === '/device/poll') {
          const body = await readJson(req, 64 * 1024).catch(() => ({}));
          const name = String(body.device || cfg.device);
          devices.set(name, { lastSeen: Date.now() });
          const q = queues.get(name) || [];
          const job = q.shift();
          queues.set(name, q);
          if (!job) {
            res.writeHead(204).end();
            return;
          }
          return sendJson(res, 200, { id: job.id, tool: job.tool, args: job.args });
        }
        if (req.method === 'POST' && p === '/device/result') {
          const body = await readJson(req, cfg.maxUploadBytes);
          const job = jobs.get(body.id);
          if (!job) return sendJson(res, 404, { ok: false, error: 'unknown job id' });
          clearTimeout(job.timer);
          jobs.delete(body.id);
          job.resolve(body.result);
          return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 404, { ok: false, error: `no device route for ${p}` });
      }

      /* ---------- agent side (agent token) ---------- */
      if (!isAuthorized(req, loadConfig())) {
        res.setHeader('www-authenticate', 'Bearer');
        return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      }

      if (req.method === 'GET' && p === '/devices') {
        const list = [...devices.entries()].map(([name, d]) => ({
          name,
          online: Date.now() - d.lastSeen < 60_000,
          last_seen: new Date(d.lastSeen).toISOString(),
        }));
        return sendJson(res, 200, { ok: true, devices: list });
      }

      if (req.method === 'GET' && p === '/tools') {
        return sendJson(res, 200, { ok: true, tools: mcpCtx.listTools() });
      }

      if (req.method === 'GET' && p === '/prompt') {
        return sendText(
          res,
          200,
          buildPrompt(cfg, { baseUrl: url.searchParams.get('base') || undefined }),
        );
      }

      if (req.method === 'GET' && p === '/approvals') {
        return sendJson(res, 200, { ok: true, approvals: listApprovals() });
      }

      const approveMatch = /^\/approvals\/([\w-]+)$/.exec(p);
      if (req.method === 'POST' && approveMatch) {
        const body = await readJson(req, 64 * 1024);
        const decision = body.decision === 'deny' ? 'deny' : 'approve';
        const r = decide(approveMatch[1], decision, 'api');
        return sendJson(r.ok ? 200 : 400, r);
      }

      if (req.method === 'POST' && p === '/exec') {
        const body = await readJson(req, cfg.maxUploadBytes);
        const result = await callTool('bash', {
          device: body.device,
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
        const result = await callTool(String(body.tool), body.args || {});
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (p === '/files') {
        const target = url.searchParams.get('path');
        if (!target) return sendJson(res, 400, { ok: false, error: 'path query parameter is required' });
        const chk = checkPath(target, cfg, process.cwd(), { write: req.method !== 'GET' });
        if (!chk.ok) return sendJson(res, 403, { ok: false, error: chk.error, reason: chk.reason });
        try {
          if (req.method === 'GET') {
            const buf = await fsp.readFile(chk.abs);
            res.writeHead(200, { 'content-type': 'application/octet-stream' });
            return res.end(buf);
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

  server.gracefulStop = () => {
    for (const job of jobs.values()) {
      clearTimeout(job.timer);
      job.resolve({ ok: false, error: 'hub shutting down' });
    }
    jobs.clear();
  };

  return server;
}

export { sleep };
