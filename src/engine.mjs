import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkPath, resolveTarget, isInside } from './policy.mjs';
import { audit, saveArtifact, tailAudit, readArtifact, auditDir } from './audit.mjs';
import { requestApproval } from './approvals.mjs';
import { loadConfig, CONFIG_PATH } from './config.mjs';
import { BrowserManager, cleanupOrphanChromes } from './browser.mjs';
import { macTools } from './mac.mjs';
import { trustState, trustAllows } from './trust.mjs';
import { errorResponse } from './errors.mjs';
import { telegramTools } from './telegram.mjs';

/* ------------------------------------------------------------------ *
 * helpers (engine_helpers.mjs)
 * ------------------------------------------------------------------ */
import { clip, runShell } from './engine_helpers.mjs';

/* ------------------------------------------------------------------ *
 * tool catalog — single source in catalog.mjs
 * ------------------------------------------------------------------ */
import { toolCatalog } from './catalog.mjs';
export { toolCatalog };


/* ------------------------------------------------------------------ *
 * engine
 * ------------------------------------------------------------------ */

export class Engine {
  constructor(cfg, { base } = {}) {
    this.cfg = cfg;
    this.base = base || process.cwd();
    this.sessions = new Map();
    this.browser = new BrowserManager(cfg);
    // Best effort: remove headless agent Chromes a previous bridge run left
    // behind. Login windows (visible) are never touched.
    cleanupOrphanChromes().catch(() => {});
  }

  catalog() {
    return [...toolCatalog(), ...this.browser.tools(), ...macTools(this.cfg), ...telegramTools(this.cfg)];
  }

  async call(name, args = {}, { requireApproval, cfg, source, actor } = {}) {
    let cfgNow;
    if (cfg) {
      cfgNow = cfg;
    } else {
      try {
        if (fs.existsSync(CONFIG_PATH)) cfgNow = loadConfig();
        else cfgNow = this.cfg;
      } catch {
        cfgNow = this.cfg;
      }
    }
    this.cfg = cfgNow;
    const src = source ? { ...source } : { channel: 'local', ip: null, country: null, host: null, client: null };
    const initiator = actor || src.actor || 'agent';
    delete src.actor;
    const record = (fields) => {
      if (this.cfg.audit !== false) audit({ tool: name, args, source: src, actor: initiator, kind: name === 'log_note' ? 'note' : 'call', ...fields });
    };
    const tool = this.catalog().find((t) => t.name === name);
    if (!tool) {
      const all = this.catalog().map(t=>t.name);
      let best=null, bestD=99;
      const lev=(a,b)=>{ a=String(a); b=String(b); const m=a.length,n=b.length; const dp=Array(m+1).fill(null).map(()=>Array(n+1).fill(0)); for(let i=0;i<=m;i++) dp[i][0]=i; for(let j=0;j<=n;j++) dp[0][j]=j; for(let i=1;i<=m;i++) for(let j=1;j<=n;j++) dp[i][j]=Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+(a[i-1]===b[j-1]?0:1)); return dp[m][n]; };
      for (const n of all) { const d=lev(name,n); if(d<bestD){bestD=d; best=n;} }
      const hint = best && bestD <= 3 ? `did you mean '${best}'?` : `available: ${all.slice(0,10).join(', ')}`;
      record({ kind: 'call', status: 'rejected', error: 'UNKNOWN_TOOL', via: 'direct' });
      return errorResponse('UNKNOWN_TOOL', { message: `unknown tool: ${name}`, tool: name, hint });
    }
    const started = Date.now();
    let approval = null;
    const entryId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(name).replace(/[^\w.-]/g, '_')}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const ctx = Object.create(this);
    ctx.entryId = entryId;
    ctx.artifacts = [];
    ctx.source = src;
    ctx.artifact = (kind, file, data, meta) => {
      const saved = saveArtifact(entryId, kind, file, data, meta);
      if (saved) ctx.artifacts.push(saved);
      return saved;
    };

    let needApproval = tool.approvalFor ? !!tool.approvalFor(args, this) : !!tool.approval;
    if (this.cfg.requireApproval === false) needApproval = false;
    if (requireApproval === true) needApproval = true;
    else if (requireApproval === false) needApproval = false;

    const artifactsOf = () => (ctx.artifacts.length ? ctx.artifacts : undefined);

    if (needApproval) {
      const trust = trustState();
      if (trustAllows(trust, tool.name, args, this.cfg)) {
        const res = await tool.handler(args, ctx);
        record({ id: entryId, status: res.ok ? 'ok' : 'error', duration_ms: Date.now() - started, via: 'trust_window', exit_code: res.exit_code, error: res.ok ? undefined : res.error, artifacts: artifactsOf() });
        return res;
      }
      approval = await requestApproval(tool.name, args, this.cfg);
      if (!approval.approved) {
        const status = approval.rec?.status || 'denied';
        const pending = status === 'pending' || status === 'timeout' || status === 'expired';
        const code = pending ? 'APPROVAL_PENDING' : 'APPROVAL_DENIED';
        record({ id: entryId, status: 'approval_denied', approval_status: status, error: code, via: 'approval', duration_ms: Date.now() - started });
        return {
          ok: false,
          error: code,
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

    const via = approval ? 'approval' : 'direct';
    try {
      const res = await tool.handler(args, ctx);
      record({
        id: entryId,
        status: res.ok ? 'ok' : 'error',
        duration_ms: Date.now() - started,
        exit_code: res.exit_code,
        error: res.ok ? undefined : res.error,
        via,
        artifacts: artifactsOf(),
      });
      return res;
    } catch (e) {
      record({ id: entryId, status: 'exception', duration_ms: Date.now() - started, error: e.message, via, artifacts: artifactsOf() });
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
