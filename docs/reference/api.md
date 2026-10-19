# HTTP API

`GET /health` (no auth, `exposeDeviceInHealth` opt) → `{ok, version, device?, pending_approvals, trust_active, audit_count, log_size, has_public_url}`

`GET /tools`, `GET /prompt`, `GET /config`, `GET /audit?limit`, `GET /audit/artifact?entry=&file=`, `GET /approvals`, `GET /approvals/:id`, `POST /approvals/:id` (localToken), `POST /call {tool,args}` → `200|202|400`, `POST /exec`, `GET|PUT|DELETE /files?path=` (via gate+audit), `POST /mcp` (2025-06-18+2026-07-28), `GET /v1/events` (SSE, bearer, heartbeat 3s).

Body ≤16 MB, response ≤8 MB, `request_id` via `bridge.log` → `audit.log`.

Every call is recorded with its full parameters (above 64 KB they move to an `args.json` artifact), the caller (`source`: channel, address, country, reverse-DNS host, client name) and an alert level. Unauthorized requests are recorded at alert level (first 5 per address per minute, then counted). Unknown tools, invalid JSON and file reads through `/files` are recorded too.
