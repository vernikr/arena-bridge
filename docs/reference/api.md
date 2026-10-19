# HTTP API

`GET /health` (no auth, `exposeDeviceInHealth` opt) → `{ok, version, device?, pending_approvals, trust_active, audit_count, log_size, has_public_url}`

`GET /tools`, `GET /prompt`, `GET /config`, `GET /audit?limit`, `GET /audit/artifact?entry=&file=`, `GET /approvals`, `GET /approvals/:id`, `POST /approvals/:id` (localToken), `POST /call {tool,args}` → `200|202|400`, `POST /exec`, `GET|PUT|DELETE /files?path=` (via gate+audit), `POST /mcp` (2025-06-18+2026-07-28), `GET /v1/events` (SSE, bearer, heartbeat 3s).

Body ≤16 MB, response ≤8 MB, `request_id` via `bridge.log` → `audit.log`.
