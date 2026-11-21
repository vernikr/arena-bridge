/**
 * Authorization gate.
 *
 * There is no approval gate and no trust window: if the service is running,
 * everything is allowed. Kept as a single always-allow entry point so that
 * PUT/DELETE /files and POST /call share one code path.
 */
export async function authorize(tool, args, cfg, source = null, actor = 'agent') {
  return { ok: true };
}
