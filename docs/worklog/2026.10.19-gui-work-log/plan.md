# Work log, access window and service controls — design and waves

Status: decisions taken 2026-10-19 (section 8). Wave 0 in progress, see section 4. Target release: MINOR (0.11.0), backward compatible log format.

## 1. Scope

Nine requests against the native macOS window (`macos/ArenaBridge`) and the Node bridge (`src/`):

1. Full parameters of every tool call are logged.
2. Detailed log of service start/stop and of the access window (trust window) open/close.
3. The log can be cleared.
4. The log can be filtered by alert level.
5. Every entry shows its source: a short id, and the domain or IP when available.
6. Times are shown in the viewer's time zone.
7. New entries appear at the bottom; the view follows them only when the user is already at the bottom.
8. A new agent tool that only writes a comment into the log.
9. Much larger log capacity without GUI slowdown.
10. Start and Stop merge into one toggle with intermediate disabled states; Setup and Copy the agent prompt move to the right edge.
11. A step indicator to the right of the toggle, with detailed start and stop steps.

## 2. Current state (verified in code)

| Area | Today | Where |
|---|---|---|
| Entry timestamp | Written as `new Date().toISOString()` with milliseconds, e.g. `2026-10-19T15:07:51.252Z`. | `src/audit.mjs` |
| Timestamp parsing in GUI | Plain `ISO8601DateFormatter()` (no fractional seconds). On parse failure the code falls back to `Date()`, so **every row shows the refresh time, not the event time**. Confirmed on the Mac in Wave 0. | `macos/ArenaBridge/Sources/Bridge.swift` `LogEntry.parse` |
| Order | Oldest-first list is reversed, so newest is on top. | `Model.swift` `refresh()` |
| Volume | GUI requests 120 entries (API cap 200). Reader only looks at the last 512 KB, so real history is much shorter. Rotation at 10 MB keeps 50%. | `Model.swift`, `src/direct.mjs`, `src/audit.mjs` |
| Parameters | Strings over 4000 chars are replaced by a placeholder; `content`/`data`/`text` over 1000 chars are replaced. Parameters are not complete. | `src/audit.mjs` `trunc()` |
| Coverage gaps | Unknown tool names return before any audit. `401` responses are not audited. `GET /files` reads are not audited. Start/stop (`launchctl`) is not audited. Trust open/close written by the GUI and by `ensureTrustOnLaunch` (3 h on each app launch) bypass the audit. Trust expiry is passive (no event). | `engine.mjs`, `direct.mjs`, `Model.swift`, `trust.mjs` |
| Source | `Engine.call(name,args)` receives no request context. Nothing about the caller is stored. | `engine.mjs`, `direct.mjs` |
| Clear / filter | No clear. Filter is by tool, detail, summary only. | `Views.swift` `LogCard` |
| Scrolling | Fixed 150 pt inner `ScrollView`, no bottom anchoring. | `Views.swift` |
| Start/Stop | Two buttons, enabled by `running`. Background refresh every 4 s can flip state mid-operation. Same actions also in the app menu. | `Views.swift` `ActionsCard`, `App.swift`, `Model.swift` |
| Config switch | `audit: false` in config disables all logging silently. | `engine.mjs` |

## 3. Design

### 3.1 Log record contract (v2, additive)

One JSON line per event in `audit.log`. Existing fields stay. New fields:

```json
{
  "id": "2026-10-19T15-07-51-252Z-bash-a1b2c3",
  "ts": "2026-10-19T15:07:51.252Z",
  "level": "info",
  "kind": "call",
  "tool": "bash",
  "status": "ok",
  "duration_ms": 182,
  "exit_code": 0,
  "via": "trust_window",
  "actor": "agent",
  "source": { "channel": "http", "ip": "203.0.113.7", "host": "ec2-203-0-113-7.compute.example.net", "client": "Arena agent", "alias": null },
  "args": { "command": "ls -la" },
  "args_truncated": false,
  "error": null,
  "artifacts": []
}
```

- `kind`: `call` | `note` | `approval` | `trust` | `service` | `tunnel` | `auth` | `log`.
- `level`: `info` | `notice` | `warning` | `alert` (see 3.4).
- `actor`: `agent` | `user` | `system`. `user` means a human action (GUI, CLI, Telegram).
- `ts` stays UTC with milliseconds (compatible with existing readers). Display is local (3.8).

### 3.2 Source capture

- Pass a request context from `direct.mjs` and the MCP handler into `engine.call(name, args, { source })`. Telegram and CLI pass their own channel name.
- IP: from the `Cf-Connecting-IP` header set by the tunnel (Cloudflare, verified in Wave 0). The header is set by the edge, and a client-supplied copy is rejected at the edge, so it cannot be forged from outside. Fall back to the socket address (127.0.0.1 when the request came through the tunnel) only if the header is missing. Also store `Cf-Ipcountry` as `country`. `X-Forwarded-For` is not used: the edge replaces it with the same client IP, so it adds nothing.
- Host (domain): reverse DNS (PTR) with a 250 ms budget and 1 h cache. Verified in Wave 0: a cloud egress address resolves to a provider name (e.g. a googleusercontent.com host), which identifies the provider, not the agent. The UI shows it as "provider host"; when there is no PTR, the IP only.
- Client: MCP `initialize` `clientInfo.name/version`, or `User-Agent` truncated to 120 chars.
- Short id shown in the list: first 6 chars of a hash of `ip|client`, plus an optional user alias stored in config (`sourceAliases`). Alias is Wave 5 optional.
- All fields are informational; authorization never depends on them.

### 3.3 Full call parameters

- Store the parameters in full after secret masking. Inline up to 64 KB per entry. Larger payloads are written as an artifact `args.json` in the entry's artifact folder, and the entry sets `args_truncated: false` with an `args_artifact` reference.
- Replace the current silent truncation with explicit handling: nothing is dropped without a pointer.
- Extend secret masking (currently Telegram, GitHub, npm, PyPI, OpenAI-style keys) with `Bearer` tokens, AWS access keys, private key blocks, and `env` values of `/exec`.
- Log the unknown-tool and invalid-body cases as `status: "rejected"` (`kind: call`, `level: warning`).
- Log `401` as `kind: auth`, `level: alert`, aggregated per source per minute to avoid flooding.
- Log `GET /files` reads as `kind: call` with `via: files_api`.
- Warn in the GUI when `audit: false` is set.

### 3.4 Alert levels and event catalogue

| Level | Meaning | Examples |
|---|---|---|
| `info` | Routine work | Successful calls, reads, agent notes, step progress |
| `notice` | Changes of state the user should know about | Service started/stopped, access window opened/extended/closed/expired, human approve/deny, log cleared |
| `warning` | Something was blocked or failed, no action needed yet | `APPROVAL_DENIED/PENDING`, `PROTECTED`, unknown tool, tool error or exception, approval timeout, tunnel reconnect |
| `alert` | Needs attention now | Unauthorized request, forbidden approval attempt with agent token, unexpected service stop, tunnel gave up, access window opened with audit disabled |

GUI filter: "≥ Info / ≥ Notice / ≥ Warning / ≥ Alert" plus text search. Default: ≥ Info.

### 3.5 Access window and service lifecycle events

Single writer rule: every mutation of the trust file goes through one Node function that also writes the audit record. The GUI calls `arena-bridge trust … --source gui` through the CLI, so it also works when the bridge is stopped. While the bridge is running, the GUI can use `POST /log/event` with the local token.

Events:

- `trust` `opened` (scope, until, actor, via: gui | cli | telegram | approval-3h | app-launch), `extended`, `closed` (by user), `expired` (timer inside the bridge when running; otherwise recorded on next GUI refresh).
- `service` `start_requested`, `step` (name, index, total, result, duration), `started` (port, version), `stop_requested`, `stopped`, `crashed` (alert).
- `tunnel` `up` (public host), `down`, `reconnecting`, `gave_up` (alert).
- `approval` `requested`, `approved` / `denied` (actor, channel), `expired`.
- `log` `cleared_view`, `history_deleted` (with archive path).

Decision needed: the app currently opens a 3-hour access window on every launch (`ensureTrustOnLaunch`). With the new logging this shows up as `trust opened, via app-launch`. Keep or drop is a product decision, see section 8.

### 3.6 Retrieval API and volume

- `GET /audit?limit=500&before=<id>` or `&after=<id>`, plus `level`, `tool`, `source`, `q`, `since`. Limit cap 1000. Response: `{ entries, next_cursor, has_more }`. List payload is lean: `args` replaced by a 200-char preview, full value fetched on click via `GET /audit/entry?id=`.
- Reverse-chunked reader (read from the end until the cursor is found), not a fixed 512 KB window.
- Retention: audit log kept 7 days and at most 20 MB; artifacts kept 7 days and at most 200 MB in total, oldest removed first. Size-based segments (5 MB each); rotation drops whole old segments instead of rewriting half a file. Full-argument overflow files count toward the artifact cap.
- SSE `audit` event carries only new entries since the last id. The GUI appends; it no longer re-downloads the whole list.

Targets: first paint of the log under 300 ms; 5 000 rows scroll smoothly; GUI memory under 30 MB at full window.

### 3.7 Agent note tool

- Name: `log_note`. Args: `text` (required, max 500 chars), no others. `approval: false`, no side effects.
- Writes `kind: note`, `level: info`, `actor: agent`. Rate limit: 1 note per second, extra notes are dropped with a warning entry.
- Rendered as plain text in the log, visually distinct (agent speech style). No Markdown, no links.
- Added to the Node catalog only (Node is canonical). README tool count and `prompt` are generated from the same catalog. Python parity is out of scope unless you ask for it.

### 3.8 Time zone

- Store UTC with milliseconds. Parse with fractional seconds (fixes the likely bug in 2).
- Display in the Mac's current system time zone, detected automatically, with the offset or zone abbreviation shown on hover. Re-render on system time zone change (`NSSystemTimeZoneDidChange`).
- Export writes ISO 8601 with offset, e.g. `2026-10-19T17:07:51.252+02:00`.
- Option in the GUI: "Show UTC".

### 3.9 GUI log panel

- Chronological order: new entries at the bottom.
- Auto-follow: track whether the scroll position is within 24 pt of the bottom (`onScrollGeometryChange`, macOS 15+; the Mac runs 15.7). Append → if pinned, scroll to the last row; if not pinned, show a "↓ New entries" pill that scrolls down on click.
- Clear: "Clear view" hides rows up to now (non-destructive, GUI state). A separate "Delete history…" removes records after archiving them to a `.jsonl.gz` file and writes a `log.history_deleted` event. Decision in section 8.
- Rows: time, level badge, kind/tool, status, source short id, duration, one-line summary. Click opens a detail sheet with the full parameters, the error, and artifacts.
- Note rows use a distinct style.
- Performance rules: formatted strings are computed once at ingest; filter results are cached and recomputed only when the filter or the data changes; `LazyVStack` with stable ids; window capped at 5 000 rows, older rows loaded by "Load older" button.
- Fixed panel height is replaced by a resizable area (drag handle), default taller than now.

### 3.10 Start/Stop control and step indicator

Single button, one state machine (`ServiceOperation` in `Model.swift`), shared with the app menu:

| Phase | Button | Enabled | Indicator |
|---|---|---|---|
| stopped | Start | yes | "Stopped" |
| starting | Starting… | no | "Step 3/6 · Starting bridge" |
| running | Stop | yes | "Running · public address ready" |
| stopping | Stopping… | no | "Step 2/4 · Stopping public address" |
| failed | Start | yes | "Failed at step 5/6: public address not ready" (red) |

Start steps:
1. Checking setup (config, service installed). If not installed: failed, "run Setup first".
2. Loading service (`launchctl bootstrap`).
3. Starting bridge (`launchctl kickstart`).
4. Waiting for local API (health, 15 s limit).
5. Opening public address (state contains a public URL, 30 s limit).
6. Checking tools (tool catalog answers, count > 0).

Stop steps:
1. Checking open work (pending approvals; shows a warning with their count).
2. Stopping bridge (`launchctl bootout`).
3. Waiting for the public address tunnel to close (verify whether the tunnel exits with the service).
4. Confirming stopped (service not listed as running).

The state comes from the operation, not from polling, so the 4 s refresh cannot overwrite a transition. Each step is written to the log as `service/step`. The indicator is clickable and jumps to the failing log row.

Layout: `[Toggle] [Indicator] ———— [Setup…] [Copy the agent prompt]`, with the right group aligned to the trailing edge.

## 4. Waves

Effort: S < 1 day, M 1–3 days, L 3–5 days. Each wave ends with a Node test run, CI green and a manual check on a Mac.

### Wave 0 — verification and contract (S) — status: done except the stop test

Results (2026-10-19, on the Mac via the bridge, macOS 15.8.1):

| Check | Result |
|---|---|
| Time bug | Confirmed. A real `ts` from `audit.log` (`2026-10-19T15:41:44.507Z`) gives `nil` with the default formatter, so the app shows the refresh time. Parsing with fractional seconds works. |
| Tunnel header | The bridge runs behind Cloudflare (`cloudflared`), not ngrok. `Cf-Connecting-IP` carries the client IP and `Cf-Ipcountry` the country. A forged `X-Forwarded-For` is replaced; a forged `CF-Connecting-IP` gets `403 error 1000`. Plan 3.2 updated. |
| Reverse DNS | Works for cloud addresses, returns a provider host. Kept as in 3.2. |
| Does stop take the tunnel down? | Probable, not yet proven on the real service. Process tree: service (group leader) → node → cloudflared, all in one process group. A test job under launchd: children in the job's group were killed by bootout; a child that started its own session survived. The stop steps keep an explicit tunnel check. Full test needs a live stop, which cuts the agent's own access; not run without your OK. |
| Audit footprint | `audit.log` 522 KB, 1 078 lines; artifacts folder 46 MB. Retention in section 8 applies to both. |
| Contract | Written: `contract.md` and `fixtures/audit-v2.jsonl` (10 examples, all required fields present). |

- Decisions in section 8 recorded.
- Acceptance: contract and fixture exist; bug confirmed; header behaviour known; open questions answered.

### Wave 1 — recording (Node, M) — status: done on branch `wave-1/log-recording`

Delivered:
- Every call goes through one recording path, with the caller (`source`) passed from the HTTP API, MCP, the hub and the device job queue. Unknown tools, invalid JSON, oversized bodies, file reads and writes through `/files`, and forbidden approval attempts are recorded.
- Full parameters: inline up to 64 KB, larger payloads in `args.json` next to the entry. Masking extended (bearer tokens, AWS key ids, private key blocks, `env` values and secret-named keys).
- Alert levels assigned in one function (`levelFor`) for all current outcomes.
- Failed authentications: first 5 per address per minute logged at alert level, the rest counted and reported when the minute ends.
- `log_note` tool: 1 to 500 characters, at most one per second, info level; listed in the agent prompt and in the tool reference.
- Tests: `test/log.test.mjs` (12 cases incl. record contract and HTTP paths). Full `npm test` passes.

Deviations from the plan:
- `via` is the authorization path for calls (`direct`, `trust_window`, `approval`, `files_api`, `api`). Lifecycle events (Wave 2) use it for their origin. Contract updated.
- MCP client name is the User-Agent: the MCP client info arrives only at initialize and the server keeps no session.
- Hub 401 entries are recorded; the hub's own job path is covered by the job source, but only by the existing smoke test, not by an assertion of its own.
- Python parity not done (Node only). Python suites already fail on main, see `docs/blockers/b01-python-approvals-unbound.md`.
- Retention (7 days, 20 MB, artifacts cap) is not in this wave: it belongs with segment rotation in Wave 2.
- Removed a duplicate screenshot entry; the call itself is recorded once by the engine with its path argument.

### Wave 1 — recording (Node, M)
- `Engine.call` takes `source`; `direct.mjs`, MCP, Telegram and CLI pass it.
- Full parameters with artifact overflow; extended masking tests.
- Log rejected, unknown-tool, `401` (aggregated) and `GET /files` reads.
- `log_note` tool with rate limit; catalog, `prompt` and README regenerated.
- Levels assigned for all existing call paths.
- Tests: `test/audit.test.mjs` (contract, masking, overflow), note rate limit, source capture from a fake request.
- Acceptance: a call with a 1 MB `content` argument is fully recoverable; `401` shows in the log at alert level; a note appears in the log.

### Wave 2 — lifecycle and paging — status: done in 0.12.0

Delivered:
- Trust events: open, extend, change, close, expire, and external changes (for example the app writing the file). Each change is logged once. Writers never duplicate each other: `trust.marker` holds the last logged state. `--source` on `trust` sets the origin.
- Launch auto-open (3 h) logged with origin `launch`.
- Bridge start and stop, tunnel up and down, with origin `launchd` or `cli`.
- `GET /audit` with `before`, `after`, `tool`, `kind`, `level` (minimum) and lean records; `GET /audit/entry` for the full record; `POST /log/event` for interface steps only; SSE `audit` deltas.
- Segments of 5 MB; retention 7 days and 20 MB for the audit log, 7 days and 200 MB for artifacts; the newest archive is never removed.
- Measured: a 500-record page from a 100 000-record log, median under 1 ms in the test (acceptance: under 100 ms).
- Tests: `test/log-paging.test.mjs` (8 cases).

Deviations:
- The app still writes `trust.json` directly until Wave 3; its changes are logged as `via: external`.
- Cursors survive one rotation within the same process; across processes a stale cursor returns `reset`.
- CI: npm publishing moved to trusted publishing (OIDC); the macOS job appends app checksums to `SHA256SUMS`.

### Wave 2 — lifecycle and paging (Node + CLI, M)
- Single writer for trust file; `--source` flag on `trust` CLI; expiry timer; `POST /log/event` (local token).
- `service` and `tunnel` events written by the bridge process; GUI step events via `POST /log/event` or the CLI when stopped.
- `GET /audit` with cursors, filters and lean payload; `GET /audit/entry`; reverse reader; segment rotation with retention.
- SSE delta events.
- Tests: trust open/close/expire produce one event each; cursor paging over 50 000 synthetic records returns no duplicates or gaps; rotation keeps the newest segment intact.
- Acceptance: every access window change in the log, from any channel; API returns 500 records under 100 ms on a 100 000-record file.

### Wave 3 — log panel (Swift, L) — status: done on branch `wave-3/log-panel`, not released
- Parse v2 with fractional seconds; local time zone display; UTC toggle; export with offsets.
- Chronological order, pinned auto-follow, "New entries" pill.
- Level filter, source short id, detail sheet, note style.
- Clear view; delete history with archive (if approved).
- Windowed buffer, cached formatting, lazy detail fetch.
- Acceptance: new entries appear at the bottom and follow only when pinned; 10 000 rows scroll without stutter; time matches the Mac's clock and changes when the time zone changes.

### Wave 4 — controls (Swift, M) — status: done on branch `wave-4/controls`, not released
- `ServiceOperation` state machine with steps, timeouts and failure reasons.
- Single toggle with intermediate disabled states; indicator; right-aligned Setup and Copy prompt.
- App menu Start/Stop routed through the same operation.
- Access window open/close actions use the CLI path from Wave 2.
- Acceptance: each step name shows in the indicator; a forced failure at step 5 shows the step and reason and logs it; refresh never changes the state during an operation.

### Wave 5 — release (S) — status: docs and CI done on branch `wave-5/docs-ci`; live stop test and release pending
- Docs: `docs/reference/api.md`, `tools.md`, `README` (generated counts), `AGENTS.md` module map, `feature-tree.md`, `CHANGELOG.md`.
- Version: set at the batch release (0.14.0 as the final of waves 3 and 4), in all version files (CI `version-check`).
- Swift build in CI on macOS runner (currently not built in CI).
- Optional: source aliases in config.
- Move this folder to `docs/worklog/archive/` when closed.

## 5. Verification

- Node: `npm test` plus new suites for audit contract, source capture, trust events, paging.
- Python: unchanged; `npm run test:python` must stay green.
- Swift: compile with `macos/ArenaBridge/build.sh` on macOS. Not possible in the current Linux sandbox; needs a Mac or a CI macOS job.
- Manual on the Mac: time zone change, long log, step failure injection (rename the service plist to force a failed step 1), trust open/close from GUI, CLI and Telegram.
- Performance: Instruments (SwiftUI and Allocations) with 10 000 rows.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Full parameters can contain secrets (e.g. `write_file` with a token) | Wider masking; file mode 0600 kept; export warns; detail view shows a "contains masked values" marker |
| Tunnel header can be forged by the client | Use last hop only; labelled "reported"; never used for auth |
| Reverse DNS slow or blocked | 250 ms budget, cache, IP fallback |
| GUI and CLI both write the log file | Only Node writes; GUI goes through CLI or local API; append-only lines |
| Rotation during reads | Segments are immutable once closed; reader works on a snapshot list |
| Swift compile not verified in this environment | Wave 4 and 3 gated on a Mac build |
| Logging volume grows with notes | Rate limit, retention, `info` default filter |

## 7. Docs and conventions

- Evergreen docs updated in Wave 5, after functional changes.
- Commit types per wave: `feat(log)`, `feat(gui)`, `fix(gui)` for the time bug if shipped alone (patch).
- Each wave is a separate push to origin.

## 8. Decisions (2026-10-19)

1. Clear: view only. No "Delete history" in this scope. [Confirmed by owner 2026-10-19]
2. Retention: audit log 7 days and at most 20 MB; artifacts 7 days and at most 200 MB; GUI window 5 000 rows. [Confirmed by owner: trim files to a reasonable limit]
3. Time zone: automatic, the Mac's system zone (Europe/Moscow on the test Mac), with UTC toggle. [Confirmed by owner]
4. Domain lookup via reverse DNS: allowed. [Confirmed by owner]
5. Access window on each app launch: keep 3 h; now logged as `app-launch`. [Confirmed by owner]
6. Python parity for `log_note`: Node only. [Default]
7. Version: 0.11.0 MINOR. [Default]
8. Source aliases in config: Wave 5, optional. [Default]
