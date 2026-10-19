# AGENTS.md — arena-bridge contributor guide

This file is for AI agents and human contributors working on arena-bridge.
Keep it short; details go to `docs/reference/`.

## Module map

| Path | Purpose | Notes |
|------|---------|-------|
| `src/catalog.mjs` `src/engine_helpers.mjs` `arena_bridge/catalog.py` | `toolCatalog()` single source + `clip`/`runShell` shared helpers | Core tools (bash/read_file/write_file/edit_file/list_dir/search_files/delete_path/file_get/file_put/audit_log/audit_artifact/sysinfo/process) — engine imports from `catalog.mjs`. Browser/desktop/telegram joined via `engine.catalog()`. |
| `src/engine.mjs` `arena_bridge/engine.py` | `Engine.call()` gate + `catalog()` join | Imports `toolCatalog` from `catalog.mjs`, `clip`/`runShell` from `engine_helpers.mjs`; approval/trust/audit pipeline, `mcpTools()`. |
| `src/gate.mjs` `arena_bridge/gate.py` | `authorize(tool,args,cfg)` | Single source for `PUT/DELETE /files` + `POST /call` gate: trust → requireApproval → requestApproval, 202 vs 403. |
| `src/policy.mjs` `arena_bridge/policy.py` | `resolveTarget`/`checkPath` + `isInside` | lstat-based symlink handling (B1). Single source for path policy. |
| `src/config.mjs` `arena_bridge/config.py` `src/state.mjs` | `loadConfig`/`saveConfig` + `DEFAULTS` + `loadState`/`saveState` (`STATE_PATH`) | `config.json` = user intent, `state.json` = runtime (`publicUrl`). Atomic tmp+rename. |
| `src/audit.mjs` `arena_bridge/audit.py` | `audit()`/`tailAudit()`/`readArtifact()`/`levelFor()` | JSON-lines, reverse-read, 5–10MB rotation. Parameters kept whole, >64 KB overflow to `args.json` artifact. Levels info/notice/warning/alert. |
| `src/source.mjs` | `describeSource()`/`sourceOf()`/`admitUnauthorized()` | Caller identity from the tunnel's `Cf-Connecting-IP`, reverse-DNS host (250 ms budget, cached), 401 rate limit per address. Node only. |
| `src/approvals.mjs` `arena_bridge/approvals.py` | `requestApproval()` file-based | 400ms poll, TTL vs wait, `trust.json` blanket window. |
| `src/trust.mjs` `arena_bridge/trust.py` | `trustState()`/`trustAllows()` + `pruneExpiredTrust()` | Blanket `tools:[]` = all tools, auto-prune expired on status. |
| `src/direct.mjs` `arena_bridge/server.py` | HTTP API (`/call`, `/files`, `/health`) | `PUT/DELETE /files` via gate + audit. 202 for pending. `/health` → `pending_approvals`, `trust_active`, `audit_count`, `log_size`. |
| `src/browser.mjs` `arena_bridge/browser.py` | `BrowserManager` + CDP | Plain launch for login, DevTools keepalive, `chrome_activate`. |
| `src/mac.mjs` `arena_bridge/mac.py` | Peekaboo desktop control | Screen, mouse, keyboard, app control. |
| `src/telegram.mjs` `arena_bridge/telegram.py` | Poller + `allowedChat` filter | Prompt-injection guard, inbox `readInbox()`. |
| `src/cli.mjs` `src/cli/browser.mjs` `arena_bridge/cli.py` | CLI (22 cmds: `init/setup/start/tunnel/hub/connect/prompt/tools/approvals/approve/trust/rotate/audit/logs/cleanup/config/telegram/doctor/status/url/open/version/update/service/browser/completion/restart`) | `parseArgs` handles `-n`/`--n`, `--json` everywhere, `doctor --fix/status`, `audit --tool/--since/--from/--to`, `config validate/diff`, `trust --extend/--history`, `browser clean`, `service logs`. |
| `src/log.mjs` `arena_bridge/log.py` | `bridge.log` structured logs | `LOG_LEVEL`, 5MB rotation. |
| `macos/ArenaBridge/` | SwiftUI app + `Bridge.swift` | One poll cycle, async `Bridge.run()`, `Info.plist` version from `package.json`. |

## How to run tests

```bash
npm test                          # Node: approvals, telegram, smoke, browser, mac, service + security
python3 -m pytest test/test_security.py -v  # Python security boundaries
python3 test/test_bridge.py       # Python bridge smoke
npm run test:python               # all Python suites via npm
```

CI (`ci.yml`): Node on ubuntu+macos, Python 3.9+3.11 on ubuntu+macos, `version-check` job.
Telegram tests are in CI (T1) — don't remove them. Release `if: success()` not `if: always()`.

## Parity rules

- **Node is canonical.** New features land in `src/*.mjs` first. Python gets security fixes only, or a thin shim in 0.9.
- Keep `catalog` identical: `GET /tools` + MCP + prompt + README counts from one source (`engine.mjs` → `prompt.py`).
- `checkPath` logic must match: lstat symlink, per-element protected check, `isInside` after `resolveTarget`.
- `audit` entry shape: `{id, tool, args, status, duration_ms, via, exit_code, error}` — no `content` bodies >1k.
- `VERSION` single source: `package.json`. Python reads via `importlib.metadata` or `package.json`. `Info.plist` generated.

## Version rules

- Source: `package.json` `version` is authority.
- Python `pyproject.toml` + `__init__.py` + `mcp.mjs`/`hub.mjs`/`Info.plist` must match. CI `version-check` enforces.
- `0.8.x` is breaking per owner: `trust --for` without `--tools` errors, `GET /health` `device` optional via `exposeDeviceInHealth`.
- Tag `v*` triggers `release.yml`: npm → pypi → GitHub Release → macos apps. `SHA256SUMS` verified in `install.sh`.

## Security boundaries (do not regress)

- `audit_artifact` traversal via `basename` + `isInside` audit dir.
- `search_files`/`list_dir` per-element `checkPath` + symlink target check.
- `PUT/DELETE /files` through `authorize()` + audit.
- `allowedChat` before `append_inbox` and `/approve`.
- Token compare via `timingSafeEqual`/`hmac.compare_digest`.
- `edit_file` preserves UTF-8, literal `$&` handling, atomic writes.

## Common tasks

- Add tool: define in `engine.mjs` `toolCatalog()` + schema, add to `TOOLS`, regenerate `prompt` if needed, mirror in Python if required.
- Change config: update `DEFAULTS`, add migration in `config.mjs` if `schemaVersion` changes, keep `saveConfig` merge logic.
- Debug: `arena-bridge doctor --json`, `arena-bridge audit -n 20`, `arena-bridge logs -f` (bridge.log).
