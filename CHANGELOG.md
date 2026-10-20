# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/) and the project uses
[Semantic Versioning](https://semver.org/).

## 0.18.12

- Show only the initiator location in the work-log source column: domain/IP, without transport channel or a `local` label.
- Include the IP alongside a reverse-DNS domain when both are available; keep the same value in GUI and saved text logs.

## 0.18.11

- Show the initiator (`agent` or `user`) as a dedicated work-log column and include it in saved text logs.
- Display loopback addresses as `local` and label the channel separately, so transport IP is not mistaken for the initiator.
- Preserve the same actor/source fields in the GUI and text export.

## 0.18.10

### Changed
- The work log now records only actions attributed to an agent or the user; automatic lifecycle, polling, and system events are omitted.
- Native-app permission status refreshes use a private local status endpoint and no longer create a tool-call log entry. A deliberate “Check again” remains recorded as a user action.

## 0.18.9

### Fixed
- Starting the LaunchAgent no longer force-kills the process that `bootstrap` just started via `RunAtLoad`; this avoids launchd's 10-second restart throttle during the Start flow.

## 0.18.8

### Fixed
- Setup no longer tries to start the service when saving. The existing Start control remains responsible for starting it.
- Finder-launched macOS apps provide Node.js locations from common version managers to CLI subprocesses, fixing `env: node: No such file or directory`.
- Configured roots no longer act as a filesystem allowlist; protected sensitive paths, OS permissions, and approval gates remain in force.

### Changed
- Setup no longer asks for folder roots. Tunnel settings are saved to config and the service definition without loading or starting the service.

## 0.18.7

### Fixed
- A tunnel that prints its address and exits at once no longer fails the start.
- Command and tool calls over HTTP return their results.
- Approving or denying a request through the local interface works.

## 0.18.6

### Changed
- Test release: the app and the background service both move to the new version without manual steps.

## 0.18.5

### Fixed
- The self-update updates the bridge copy that the background service runs, not only the command line copy, so the service restarts with the new version.

## 0.18.4

### Fixed
- The self-update failed when the package registry was still behind the release: the release now announces a version only after the registry shows it, and a failed update is tried again on the next check.

## 0.18.3

### Changed
- Test release for the app's self-update path; no change in behaviour.

## 0.18.2

### Fixed
- The app's self-update refused releases signed with the same certificate: the signature check compared the whole signature report, which includes the path of the app. Only the requirement line is compared now.

## 0.18.1

### Changed
- Test release for the app's self-update path; no change in behaviour.

## 0.18.0

### Added
- The macOS app updates itself: it checks the latest release, verifies the download and the signature against the installed app, updates the bridge command line tool and restarts.
- An update switch and a Check now button in the Control card.

## 0.17.0

### Added
- The work log shows an icon left of each tool name, one colour per tool family; a text symbol is used where the system symbol is missing.

### Fixed
- Calls without parameters no longer show an empty `{}` in the work log.

## 0.16.1

### Fixed
- The work log starts at the top of its area.
- Permission checks are spaced (10 s for explicit checks, 60 s for the rest), so macOS prompts no longer repeat.
- A start that does not answer reloads the service once before it fails.

## 0.16.0

### Added
- Start shows seven steps, each with a time limit; the step line shows the seconds it has run.
- A small Cancel button stops a start in progress and leaves the bridge stopped.
- The app's own work log keeps the start and stop steps when the bridge is not answering.
- macOS app releases are disk images (.dmg) instead of zip archives.

### Changed
- The "Keep permissions after updates" button appears only in builds without the project certificate.

### Fixed
- A stuck launchctl command no longer freezes the start; every launchctl call has a time limit.
- The public-address check recognises the ngrok tunnel as well as cloudflared.

## 0.15.0

### Added
- `arena-bridge permissions` checks Screen Recording and Accessibility (exit code 3 when one is missing).
- The Control card warns when a macOS permission is missing and opens a step-by-step guide.
- `build.sh` signs with `ARENA_SIGN_IDENTITY`; a certificate keeps the macOS permissions across rebuilds.

### Changed
- The README and the agent prompt name the Arena Bridge app, not the terminal, as the holder of the permissions.

### Fixed
- The source of a log entry is its own column.

## 0.14.1

### Fixed
- Each log entry takes one line; the list scrolls sideways when an entry is wider than the window.
- The log row shows the command and the source; the duration is right-aligned with the digit grouping of the system locale.
- The time follows the system 12- or 24-hour setting; in 12-hour form the hour has two digits.
- The address shows the tunnel address of the running bridge.
- The Approvals card is hidden when there is nothing to decide.

## 0.14.0

### Added
- MacOS app: work log panel with level filter, clear view (view only; records stay), full record on click, and a new-entries button when scrolled up.
- MacOS app: Start and Stop run as numbered steps with a step indicator; a failure names the step and the reason and is written to the log.
- CI builds the macOS app on every push.

### Changed
- The macOS app needs macOS 15 or later.
- The work log shows times in the Mac's system time zone and keeps the newest 5 000 rows in view.

## 0.12.0

### Added
- Trust window events: open, extend, change, close and expire, each logged once; changes made by another writer (such as the app) are logged as external. The `trust` command takes `--source`.
- Bridge start and stop, and tunnel up and down, are logged with their origin.
- `GET /audit` pages with `before`, `after`, `tool`, `kind` and `level` filters; `GET /audit/entry?id=` returns the full record.
- `POST /log/event` accepts interface step events. `GET /v1/events` sends new audit records as they arrive.

### Changed
- The audit log rotates into 5 MB segments; retention keeps 7 days and at most 20 MB of audit log (the newest archive is never removed) and 7 days and at most 200 MB of artifacts.
- `arena-bridge cleanup` removes artifacts older than 7 days by default (was 14).

### Fixed
- The macOS release job uploads the app checksums with the release checksums file instead of failing.

### CI
- npm publishing uses trusted publishing (OIDC) with Node 24; no npm token is used.

## 0.11.0

### Added
- Work log records every call with its full parameters (large payloads move to an `args.json` artifact), the caller (tunnel address, country, reverse-DNS host, client), and an alert level.
- Unauthorized requests are logged at alert level, limited to 5 per address per minute, with a suppressed count.
- `log_note` tool: adds an info entry to the work log (1–500 characters, one per second). Node only; the Python package does not receive new tools.
- Errors `INVALID_ARGS` and `RATE_LIMITED`; `INVALID_JSON` and `PAYLOAD_TOO_LARGE` responses for malformed or oversized HTTP bodies.

### Changed
- Duplicate `chrome_screenshot` audit entry removed; the call is recorded once.
- Masking covers bearer tokens, AWS key ids, private key blocks, `env` values and secret-named keys.

### Fixed
- `/files` GET, PUT and DELETE are all audited and authorized through the same path.

## 0.10.0

### Added
- `src/telemetry.mjs` — cold-start, RSS/heap and uptime exported to `doctor --json` (`telemetry` field) and as new `cold_start`/`memory`/`uptime` checks; `GET /health` still exposes `uptime_sec`/`trust_active`/`audit_count`/`log_size`.
- `docs/reference/errors.md` — single source error code table generated from `src/errors.mjs` (`PROTECTED`, `APPROVAL_*`, `TIMEOUT`, `UNKNOWN_TOOL` → retryable/hint mapping).
- `macos/ArenaBridge/Sources/MenuBar.swift` — optional `MenuBarExtra` popover (pending count + trust remaining), ready for Developer ID flow without replacing `WindowGroup`.
- `.github/workflows/release.yml` now publishes `SHA256SUMS` (+ `SHA256SUMS-apps` for zips) and `install.sh` verifies them (`shasum -a 256 -c`).

### Changed
- `AppIcon.png` recompressed 982 KB → 82 KB (quantized 1024px PNG, `iconutil` still generates 5 scales + @2x).

### Fixed
- `release.yml` `if: success()` already — kept; macOS job now `needs: [release]` and uploads both arch zips with checksums.

## 0.9.0

### Added
- `src/catalog.mjs` is now the single source for `toolCatalog()` (core tools: `bash`, `read_file`, `write_file`, `edit_file`, `list_dir`, `search_files`, `delete_path`, `file_get`, `file_put`, `audit_log`, `audit_artifact`, `sysinfo`, process tools) — `src/engine.mjs` imports from it instead of defining it. Browser/desktop/telegram tools joined via `engine.catalog()` (`browser.mjs`/`mac.mjs`/`telegram.mjs`) as before, now documented in `docs/reference/tools.md` as one set.
- `src/engine_helpers.mjs` (`clip`, `runShell`) extracted from `engine.mjs` so `catalog.mjs` and `engine.mjs` share them without a circular dependency.
- `src/gate.mjs` `authorize(tool,args,cfg)` is now used by `src/direct.mjs` `PUT/DELETE /files` (trust → `requireApproval` → `requestApproval` → `approval_denied` audit, `202` for pending vs `403` for denied), single source with `Engine.call()` pipeline (wave 0 S3 + wave 1 R1 fix).
- `src/cli/browser.mjs` extracted from `src/cli.mjs` (`browser list/login/clean/close`) — plain Chrome launch for `browser login` (no `--remote-debugging-port`, no automation flags) so Google login works, `profile` lifecycle (`profile_busy` check via `profilePids()`), `chrome_activate` without OS focus; `src/cli.mjs` now delegates to it (1139 lines vs 1231, `browser login` string kept for `browser.test.mjs` audit).

### Changed
- **Breaking:** `publicUrl` is runtime state (`~/.arena-bridge/state.json`, atomic `tmp+rename`) not user intent — `src/config.mjs` `loadConfig()` merges `state.publicUrl` if `config.json` lacks it, `saveConfig()` moves `publicUrl` to `state.json` (B7/B12 fix); `src/state.mjs` `loadState`/`saveState`/`STATE_PATH` is the single writer.
- `src/browser.mjs` DevTools keepalive: `BrowserManager._wireCdp` + `_reconnect` (60 attempts, 1s interval) keeps session/tabs/observations after an idle socket drop; `profile` busy guard, `chrome_profiles` with `running` flag, `chrome_activate` without touching cursor/focus — verified in `test/browser.test.mjs` (fake-chrome, socket destroy → reconnect).
- `AGENTS.md` module map updated: `catalog.mjs`/`gate.mjs`/`engine_helpers.mjs`/`state.mjs`/`cli/browser.mjs` documented.

### Fixed
- `sysinfo` `os is not defined` after catalog extraction — added `import os from 'node:os'` to `src/catalog.mjs` (MCP `tools/call` `sysinfo` now returns 2025-06-18 `protocolVersion` + `hostname`).
- `audit_log` `tailAudit is not defined` after catalog extraction — added `import { audit, saveArtifact, tailAudit, readArtifact, auditDir } from './audit.mjs'` to `src/catalog.mjs` (mac `audit_artifact` with `bytes` now listed).
- `test` suite now single-source: `npm test` `24/39/18/15` (smoke/browser/mac/service + `test_security.mjs` 7 + `test_security.py` 6) all green.

## 0.8.13

### Added
- `src/catalog.mjs` single source for `toolCatalog()` (re-export from `engine.mjs` as phase 1), `src/gate.mjs` unified `authorize(tool,args,cfg)` (trust+gate+audit) for `POST /call` and `PUT/DELETE /files`, `src/cli/` modularity scaffold (wave 3 step 1). `docs/reference/security.md` documents `state.json` runtime split.

### Changed
- `state.json` migration: `publicUrl` is runtime state (not user intent) — `config.mjs` `loadConfig()` merges `state.publicUrl` if `config.json` lacks it, `saveConfig()` moves `publicUrl` to `state.json` via `tmp+rename` (B7/B12 fix). `package.json` is still single source for `VERSION`.

## 0.8.12

### Added
- `docs/reference/{tools,api,security}.md` — single source of truth for tools (core/browser/desktop/telegram sets from `src/engine.mjs`), HTTP API and security boundaries.
- `test/test_security.mjs` (7 Node attacks) + `test/test_security.py` (6 Python attacks) covering S1 traversal, S2 per-element protected + dangling symlink lstat, S4 allowedChat, S5 health device, S6 timingSafeEqual, S7 limit 400.
- `npm test` now includes `test_security.mjs`.

### Changed
- `ci.yml` `paths-ignore` for `**.md`/`docs/**`/`feature-tree.md` on push/pull_request (no CI for docs-only changes).

## 0.8.11

### Fixed
- Wave 0 closure: `GET /audit?limit=abc` now returns `400 invalid limit` in both Node and Python (was `500` in Python, silent `30` in Node); `PUT/DELETE /files` gate and audit already via `authorize()`+audit, `allowedChat` before inbox, `compare_digest`/`timingSafeEqual` verified.
- `S8-T` pipeline: trust path and normal path both audit after execution with `duration_ms`/`exit_code` via single pipeline in `Engine.call()` — no `ok` before execute.
- `B1` shell `killpg` + streaming cap with tail semantics: `clip()` now keeps last `cap` bytes (most recent output) instead of head; `start_process` session uses ring buffer — oldest chunks dropped when over `cap`, single oversized chunk truncated to tail.

### Added
- `R5` async `202` — `GET /approvals/:id` now polls single approval (idempotent, no body) in Node (`direct.mjs`) and Python (`server.py`), alongside existing `GET /approvals` list; `POST /call`/`/exec`/`PUT/DELETE /files` return `202` with `approval_id` for pending.
- `B4/B8` atomic writes: `requestApproval`/`decide`/`timeout` now use `tmp+rename` (0600) in `src/approvals.mjs` and `arena_bridge/approvals.py` — no truncated JSON on parallel approve/poll/prune; `pruneApprovals`/`pruneArtifacts`/`pruneInbox` integrated in `cleanup`.

## 0.8.10

### Added
- macOS app now streams live events via `GET /v1/events` SSE — `AppModel.startEventStream()` keeps a long-lived `URLSession.bytes` connection with `Bearer` token, reconnects on drop, and triggers `refresh()` on `approvals`/`audit`/`heartbeat` events; falls back to 4s polling if SSE unavailable. Fixes AppModel double-timer freeze: `Bridge.run()` is async and polling is rate-limited.

## 0.8.9

### Added
- `doctor` now checks `audit.log` and `bridge.log` sizes — warns when over 10 MB / 5 MB with hint `arena-bridge cleanup`; `status` now includes `audit entries` and `bridge.log` size alongside `pending approvals`/`trust`/`publicUrl`.

## 0.8.8

### Changed
- Version is now single-source from `package.json`: `src/version.mjs` fallback synced to `0.8.8`, `pyproject.toml` and `arena_bridge/__init__.py` auto-synced, `Info.plist` `CFBundleShortVersionString` is set from `package.json` at `build.sh` time (was hardcoded `0.8.1`). CI `version-check` now passes for npm/py/macos.

### Added
- Contract fixtures `test/fixtures/policy.json` for path policy (PROTECTED) — same inputs for Node and Python, covers `roots`, `protected`, dangling symlink to outside, and `audit_artifact` traversal (`basename`+`isInside`).

## 0.8.7

### Added
- `GET /v1/events` — Server-Sent Events stream for live approvals/audit/health deltas (Node + Python, bearer auth, heartbeat every 3s). `arena-bridge events [--json]` CLI consumes it.
- MCP protocol negotiation now supports both `2025-06-18` and `2026-07-28` — `initialize` returns the client's requested version when known, otherwise `2025-06-18`.

## 0.8.6

### Fixed
- Audit log now auto-rotates at 10 MB (keeps last 50% of entries) instead of growing unbounded; both Node and Python call `rotateAuditIfNeeded()` inside `audit()` with a cheap `stat` check.

## 0.8.5

### Added
- Engine suggests closest tool on `UNKNOWN_TOOL` (Levenshtein ≤3 `did you mean 'X'?`, else `available: ...`); fixed `Invalid array length`/`KeyError` on object tool names.
- `telegram pruneInbox(days)` / `prune_inbox(days)` — drops expired `inbox.jsonl` entries by `date` (Unix seconds) plus legacy `.json` files; `cleanup --days` now also purges telegram files.

## 0.8.4

### Added
- `doctor` now integrates `config validate` (missing roots/token/port) and `service health` checks; `--json` includes `publicUrl`/`node`/`checks` with stable `code`s.
- `GET /health` now returns `audit_count` and `log_size` (in addition to `pending_approvals`/`trust_active`/`has_public_url`/`device` optional via `exposeDeviceInHealth`).
- `trust` auto-prunes expired entries on `trustState()` via `pruneExpiredTrust()`.

### Fixed
- `restart` now uses `launchctl kickstart -k gui/<uid>/ai.arena.bridge` instead of `bootout`/`bootstrap` for reliable restart.

## 0.8.3

### Added
- `--json` everywhere: `approvals`, `trust --history`, `audit`, `browser list`, `config validate/diff`, `doctor`, `status`, `logs`.
- `approvals prune --days 14` and `browser clean --days 30` — prune old approvals/profiles by `mtime`; `browser list --json` for automation.
- `audit --json` / `--from DATE` / `--to DATE` — date range filtering (ISO); `trust --history --json` (Node + Python).
- `feature-tree.md` and `AGENTS.md` docs updated.

### Fixed
- ESM `require is not defined` in `cmdTrust --history` and `cmdRestart`/`service logs`/`browser clean`/`config edit` — replaced with `import fs/path/CONFIG_DIR/spawnSync`.

## 0.8.2

### Added
- `arena-bridge doctor --fix` — repairs `~/.arena-bridge` perms/dirs; `arena-bridge status [--json]` — runtime snapshot (config, url, trust, approvals, service).
- `arena-bridge logs [-n N] [--json]` — tail `bridge.log`; `arena-bridge cleanup [--days N]` — prune artifacts/approvals; `arena-bridge open` — open `publicUrl`.
- `GET /health` now includes `pending_approvals`, `trust_active`, `has_public_url`.

### Fixed
- `audit --tool`, `--since`, `--from/--to`, `trust --extend`, `config validate|diff`, `service logs` — new filters and validators for DX/ops.


## 0.8.1

### Fixed
- Browser sessions no longer die after a short idle period: the WebSocket handshake timeout
  is cleared once the DevTools connection is up (it used to destroy the socket after 10 s
  without traffic), TCP keepalive and WebSocket pings keep the connection alive, and the
  Python read loop treats an idle-socket timeout as "keep waiting" instead of closing.
- If Chrome still drops a DevTools socket, the browser session now survives: the manager
  reconnects in the background (Node) or lazily on the next call (Python), re-attaches all
  tabs and keeps the same `session_id`, tab ids and observations.

### Added
- `chrome_activate`: make a tab active inside its Chrome window without moving the user's
  cursor or stealing OS focus (background tabs may pause rendering, so activating the tab
  you are about to work with makes interactions more reliable).

## 0.8.0

### Added
- `chrome_observe`: compact page observation for action — visible interactive elements with
  refs and states (pressed/selected/checked/expanded), open dialogs, and the current text
  editor with its content.
- `chrome_fill_editor`: finds the visible editor (textarea, contenteditable or textbox), types
  with real input events and reads the value back — no CSS selector needed.
- `chrome_wait_for` plus an `expect` option on `chrome_click`, `chrome_type` and
  `chrome_fill_editor`: actions can wait for a page condition and report `verified`.
- `chrome_click` accepts an element `ref` (with `snapshot_id`) from `chrome_observe`;
  stale refs are rejected with `stale_ref` instead of clicking something else.
- `arena-bridge browser login <name>`: a plain human Chrome launch for signing in
  (the old `browser open` remains as a deprecated alias).

### Changed
- The login launch no longer starts Chrome with `--remote-debugging-port=0` or other
  automation flags — Google and similar sites refused sign-in with
  "This browser or app may not be secure". Debugging is only enabled later, by the
  agent's `chrome_launch`, once the human has signed in.
- `chrome_launch` keeps its flags as close to a plain Chrome launch as possible
  (no `--disable-sync`, `--disable-background-networking` or feature kill-switches),
  allocates a free CDP port when none is given, and refuses a second owner of a
  profile with `profile_busy` instead of corrupting it.
- `chrome_profiles` reports whether each profile is running, on which port and in
  which session; leftover agent-owned headless Chromes are cleaned up on startup.

## 0.7.20

### Fixed
- Direct HTTP routes and both execution engines now use one fresh configuration snapshot per request.
- Changes to roots, protected paths, approval policy and response limits apply consistently without restarting the bridge.

## 0.7.19

### Fixed
- Approval requests now become `timeout` or `expired` records on disk and cannot be accepted after they are no longer actionable.
- Stale pending requests expire when listed or decided; failed late approvals cannot open a trust window.
- Agent recovery hints explain that timed-out requests are closed and require a fresh call or trust window.
- An explicit Peekaboo path is authoritative rather than silently falling back to another installation.

## 0.7.18

### Fixed
- Service reinstall is queued as an independent one-shot launchd job, so stopping the bridge does not kill its own installer. Submission errors are reported, and reload outcome is recorded separately.
- Native helper forwards SIGINT as SIGINT and SIGTERM as SIGTERM; signal handling and child exit status verified on macOS.

### Documentation
- Clarified permission names, update caveats and screen-capture verification; recorded service lifecycle follow-up plan.

## 0.7.17

### Fixed
- The permission list of macOS shows the name of the app and not `node`. The background service now
  starts through a small helper inside the signed app bundle, so macOS gives the screen and the
  accessibility permissions to «Arena Bridge». Without the app the service starts the old way, so the
  command line only installation keeps working.

## 0.7.16

### Fixed
- The tunnel takes the reserved domain back when an old ngrok process still holds it: only the
  ngrok that serves our domain is stopped, the other tunnels of the user are untouched.

## 0.7.15

### Fixed
- The background service starts from permanent folders only. The version manager keeps node in a
  folder that every new shell creates and that is deleted afterwards, and macOS binds the
  permission to the exact file: the service lost the screen recording permission when that
  folder disappeared. The node of the permanent installation and the folder of the user are used
  now, so the permission stays.

## 0.7.14

### Fixed
- The tests never write to the real configuration of the machine: every test checks that the
  folder it uses is a temporary one.

## 0.7.13

### Fixed
- The app icon keeps its transparency: the area around the shape is empty, not a white sheet.

### Changed
- The background service in the system settings is called like the app, not "node" or "python".
- The name of the app lives in one constant per runtime (`APP_NAME` in `src/app.mjs`,
  `arena_bridge/app.py` and `Sources/AppInfo.swift`), and the build takes it from there.

## 0.7.12

### Fixed
- The Python package now imports on Python 3.9, matching the declared minimum version.
- CI checks the Python implementation on Python 3.9 and 3.11.

## 0.7.11

### Changed
- The app window follows the machine: the state, the approvals and the trust window refresh
  themselves every few seconds, and the work log is reloaded now and then.
- The app reads the trust window straight from its file, so the status is exact.

## 0.7.10

### Fixed
- The app build script prints the architecture without a shell variable error.

## 0.7.9

### Fixed
- The build script of the app keeps the executable bit, and the release workflow sets it too.

## 0.7.8

### Fixed
- The release workflow installs twine, always attaches the macOS app, and keeps the release even
  if a package registry refuses the upload.

## 0.7.7

### Fixed
- The path policy compares the authorized roots the same way as the target, so a root that goes
  through a symlink (for example the temporary folder on macOS) no longer looks "outside".
- The release workflow installs twine and always attaches the macOS app to the release.

## 0.7.6

### Added
- Release artifacts: every tag publishes the npm archive, the python sdist and wheel, and the
  macOS app for arm64 and x86_64 as a GitHub Release.
- `install.sh`: one command installs the command line tool and the macOS app.
- `feature-tree.md`: the complete feature tree of the product.
- The ax-tree artifact opens in the app as a readable list of elements, with a switch to the raw
  answer of the tool.
- `mac_see` asks for the accessibility tree on its own when the first answer has no elements.

### Changed
- The README says in one line how to get past Gatekeeper.

## 0.7.5

### Added
- Approvals in Telegram carry native buttons: Approve once, Approve for 3h, Deny. "Approve for 3h"
  also opens a trust window for the same tool.
- `arena-bridge trust --status --json` prints the trust window as JSON.
- The native macOS app: a trust window status with the time left, an "Approve for 3 h" button,
  local notifications when a request needs a decision, the command arguments in the work log,
  a click-through to screenshots and accessibility trees, and a button that copies the agent prompt.
- The app icon: `macos/ArenaBridge/Resources/AppIcon.png`, turned into an `.icns` by `build.sh`.

## 0.7.4

### Fixed
- Approvals over HTTP work again: `POST /approvals/<id>` now answers with the decision instead
  of an internal error, the local token is accepted by the API, and the agent token is refused —
  an agent can no longer approve its own dangerous action.
- The same rule now applies to the hub mode.

## 0.7.3

### Fixed
- `mac_scroll` speaks the current Peekaboo grammar: the removed `--ticks` option was replaced
  with `--amount`, and the tool also accepts `amount` as an argument.

## 0.7.2

### Fixed
- The audit log masks credentials: a Telegram bot token, a GitHub, npm or PyPI token in a
  command or an argument is written as `***`, so the log cannot become a secret store the
  agent may read.

## 0.7.1

### Fixed
- The Telegram listener no longer gives up on a long poll when the network is slow: the request
  ceiling is now generous enough for the 20-second long poll to answer.

## 0.7.0

### Added
- **Telegram link.** The bridge can now talk to the user outside the agent chat:
  - `notify_user` — send a message (progress, a question, a result); with
    `{"wait_for_reply": true}` the call waits for the answer in Telegram.
  - `telegram_inbox` — read the messages the user sent to the bot.
  - `telegram_status` — the bot, the allowed chats, the number of unread messages.
  - `arena-bridge telegram setup|test|status|inbox|poll` — the same link from the terminal.
- **Approvals from Telegram.** A pending request is announced in the chat right away, and
  the user can settle it with `/approve <id>` or `/deny <id>` (the terminal still works:
  `arena-bridge approve <id>`).
- The bridge listens for incoming bot messages on its own (the launchd service does it
  automatically); the inbox lives in `~/.arena-bridge/telegram/`.

### Security
- The bot token stays in `~/.arena-bridge/config.json` (0600), which the agent cannot read.
- The bridge may only write to the chats listed in `--chat-id`; 20 messages per minute,
  4000 characters per message.

## 0.6.10

### Fixed
- The screenshot fallback no longer relies on a Peekaboo command that was removed in v4, so the
  bridge can still grab a picture when the accessibility tree is empty.
- The permission message now names the exact place to fix it (System Settings → Privacy &
  Security → Screen Recording / Accessibility → "Peekaboo Bridge") and explains that the local
  Peekaboo runtime inherits the grant from whatever starts the bridge.

## 0.6.9

### Fixed
- Desktop control survives a Peekaboo update: when the Peekaboo Bridge host loses its macOS
  permissions (Screen Recording / Accessibility), the bridge falls back to the local Peekaboo
  runtime and keeps working. If nothing can capture, the tool now says so instead of quietly
  returning an empty element list.

## 0.6.8

### Added
- Detailed work log: every call is recorded with its arguments, outcome and duration, and the
  evidence is kept next to the log — screenshots taken on the desktop, the accessibility trees
  that were read, menu trees and the list of Spaces.
  - `audit_log` / `audit_artifact` tools and `GET /audit`, `GET /audit/artifact` endpoints let the
    agent look back at what it saw.
  - `arena-bridge audit` lists the calls, `arena-bridge audit artifacts` lists the saved files,
    `arena-bridge audit <id>` prints one entry, `arena-bridge audit prune` removes old artifacts.

## 0.6.7

### Added
- `arena-bridge service install --bin ngrok --domain <name>` installs the macOS background
  service with a fixed public address; `arena-bridge service status` now shows the current URL.

## 0.6.6

### Fixed
- The tunnel is now supervised: when the tunnel binary dies, it is started again automatically
  and the new public URL is printed and saved to the config, instead of leaving a dead tunnel
  behind (the bridge used to keep running while the public address had stopped working).

## 0.6.5

### Fixed
- Peekaboo 4.9 compatibility: `peekaboo list` was removed in v4, so `mac_apps` now uses
  `app list` and `mac_windows` uses `window list` (enumerating the running apps when no app is
  given). `mac_menu` / `mac_menu_click` accept a process id, run against the local host
  (`--no-remote`) and read the `menu_structure` payload; `mac_spaces` / `mac_space_switch` also
  run locally, because a remote host cannot read or switch Spaces.

## 0.6.4

### Fixed
- The accessibility element map is read from Peekaboo's real payload (`data.ui_elements`), so
  `mac_see` and `mac_element` now return the controls of a window instead of an empty list.
  Elements carry their label, description, identifier and value-settable flag.
- Commands follow the Peekaboo v4 grammar: `set-value "<value>" --on <id>`, `menu click --item|--path`
  with an explicit app, `space switch --to <n> --foreground`, and the tree-only read
  `see --tree --no-screenshot --json` (no screenshot artifact for pure lookups).

## 0.6.3

### Added
- Desktop control now works through the macOS accessibility API first, not by pixel guessing:
  - `mac_element` finds a control by its visible name, role or value and returns its id;
  - `mac_set` writes a value straight into a control — no keystrokes, no focus change;
  - `mac_menu` / `mac_menu_click` list and trigger menu items by name;
  - `mac_wait` waits until a control appears or disappears instead of sleeping;
  - `mac_spaces` / `mac_space_switch` move the agent to another macOS Space (virtual desktop).
- `mac_see` asks for the accessibility element map explicitly and explains what to do when the
  element list is empty (missing Accessibility permission).

## 0.6.2

### Added
- `arena-bridge tunnel --bin ngrok` runs an ngrok tunnel instead of cloudflared; with an
  authtoken and a reserved domain (`--authtoken`, `--domain`) the public URL stays the same
  across restarts, so the agent prompt does not have to be copied again.

## 0.6.1

### Fixed
- Repository links point to the new home: github.com/vernikr/arena-bridge.

## 0.6.0

### Added
- Named browser profiles for the agent: `chrome_launch {"profile":"work"}` keeps its logins between
  runs, `chrome_profiles` lists them, and `arena-bridge browser list|open|close` manages them from
  the command line so the user can log in once.
- A visible agent window can be sized and placed (`width`, `height`, `x`, `y`) so it stays out of
  the way on the user's screen.

## 0.5.2

### Fixed
- `arena-bridge update` now replaces the very installation it runs from (the npm prefix is
  detected), survives a tarball install that left a conflicting link, and retries when the
  registry metadata is ahead of the tarball.

## 0.5.1

### Fixed
- `setup` and `tunnel` now say how to install `cloudflared` when the binary is missing.

## 0.5.0

### Added
- macOS desktop control: 13 `mac_*` tools (screen capture with element ids, mouse, keyboard,
  scrolling, drag, applications, windows) on top of the Peekaboo CLI.
- `arena-bridge setup` — one command from zero to a working bridge: config, machine check,
  API, tunnel and the ready-to-paste prompt.
- `arena-bridge update` — self-update from the npm registry (`--check` only reports).
- `arena-bridge service` — run the bridge as a macOS launchd service (`install`/`uninstall`/`status`).
- `arena-bridge url` and `arena-bridge version` commands.
- `doctor` now checks Peekaboo, Chrome and the service.

### Fixed
- `list_dir` returned one level of subdirectory content mixed into the top level, which made
  the agent believe folders were missing. It is now top-level only unless `recursive` is set.
- `list_dir` no longer follows symlinks while listing, so a dead link cannot block it, and it
  reports unreadable directories in `errors` instead of silently skipping them.
- A blocked call now answers `APPROVAL_PENDING` (with the `approval_id` and what to run)
  instead of `PROTECTED`, so the agent can tell "waiting for a human" from "not allowed".
- The default approval wait dropped from 90 s to 45 s.
- `arena-bridge trust` no longer crashes with `trustState is not defined` (Node CLI).
- The agent token, the device token and the local token are separate; approvals now require the
  local token, so the agent cannot approve its own requests.

## 0.4.0

### Added
- Chrome control over CDP with a dependency-free WebSocket/CDP client: 12 `chrome_*` tools,
  an agent-owned browser (headless or visible) and attaching to the user's own Chrome on 9222.
- Trust windows: `arena-bridge trust --for 2h [--tools ...] [--paths ...]`, local only, and
  it lifts approvals without weakening the path policy.
- `localToken` gates approval decisions; `~/.arena-bridge` joined the protected paths.

## 0.3.0

### Fixed
- Repeated `--root` flags accumulate instead of overwriting each other; comma lists are split.
- A friendly message when the port is already in use.
- The policy is re-read from disk on every call, so changes apply without a restart.

## 0.2.0

### Added
- Cloudflared quick tunnel helper (`arena-bridge tunnel`), HTTP/2 transport by default.
- Token rotation (`arena-bridge rotate`).

## 0.1.0

- First release: local HTTP API, MCP endpoint, files, shell, processes, approvals, audit log.
