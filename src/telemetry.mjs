// telemetry: cold-start + memory + timing for doctor/status/health
let t0 = Date.now();
try { t0 = Number(process.env.ARENA_BRIDGE_T0) || Date.now(); } catch {}
export function coldStartMs() { try { return Date.now() - t0; } catch { return 0; } }
export function mem() {
  try { const m=process.memoryUsage(); return { rss: Math.round(m.rss/1024), heapUsed: Math.round(m.heapUsed/1024), heapTotal: Math.round(m.heapTotal/1024) }; } catch { return null; }
}
export function uptimeSec() { try { return Math.round(process.uptime()); } catch { return 0; } }
