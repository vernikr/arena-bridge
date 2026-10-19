# HTTP API

`GET /health` (no auth, `exposeDeviceInHealth` opt) → `{ok, version, device?, pending_approvals, trust_active, audit_count, log_size, has_public_url}`

`GET /tools`, `GET /prompt`, `GET /config`, `GET /audit?limit&before&after&tool&kind&level`, `GET /audit/entry?id=`, `POST /log/event` (step events, bearer), `GET /audit/artifact?entry=&file=`, `GET /approvals`, `GET /approvals/:id`, `POST /approvals/:id` (localToken), `POST /call {tool,args}` → `200|202|400`, `POST /exec`, `GET|PUT|DELETE /files?path=` (via gate+audit), `POST /mcp` (2025-06-18+2026-07-28), `GET /v1/events` (SSE, bearer, heartbeat 3s).

Body ≤16 MB, response ≤8 MB, `request_id` via `bridge.log` → `audit.log`.

Every call is recorded with its full parameters (above 64 KB they move to an `args.json` artifact), the caller (`source`: channel, address, country, reverse-DNS host, client name) and an alert level. Unauthorized requests are recorded at alert level (first 5 per address per minute, then counted). Unknown tools, invalid JSON and file reads through `/files` are recorded too.

Work log paging: `GET /audit` returns up to 500 records, oldest first, in the lean form (no parameters; `args_preview` holds the first 200 characters). `next` is the cursor for the page before; `head` is the cursor at the end of the log. Pass `after=<cursor>` to read records written since, and `before=<cursor>` to read further back. `level` is a minimum (`warning` returns warning and alert). Cursors are opaque; an unknown or retention-removed cursor returns `reset: true` with `head`. `GET /audit/entry?id=` returns the full record, including parameters. `POST /log/event` accepts `{kind:"step", tool, status, level, message}` only; trust and service events are written by the bridge itself. `GET /v1/events` sends `audit` events with new lean records on each heartbeat.

Trust and lifecycle events (kind `trust`, `service`, `tunnel`) are written in the same log. See `docs/worklog/2026.10.19-gui-work-log/contract.md`.
