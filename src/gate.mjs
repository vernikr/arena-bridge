import { trustState, trustAllows } from './trust.mjs';
import { requestApproval } from './approvals.mjs';
import { audit } from './audit.mjs';

export async function authorize(tool, args, cfg, source = null, actor = 'agent') {
  const trust = trustState();
  let needApproval = true;
  if (trustAllows(trust, tool, args, cfg)) needApproval = false;
  else if (cfg.requireApproval === false) needApproval = false;
  if (!needApproval) return { ok: true };
  const approval = await requestApproval(tool, args, cfg);
  if (!approval.approved) {
    const status = approval.rec?.status || "denied";
    const pending = status === "pending" || status === "timeout" || status === "expired";
    try { audit({ tool, args, status: "approval_denied", approval_status: status, via: "approval", actor, source, error: pending ? "APPROVAL_PENDING" : "APPROVAL_DENIED" }); } catch {}
    return { ok: false, status, approval_id: approval.rec?.id || null, pending };
  }
  return { ok: true };
}
