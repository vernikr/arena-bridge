# AGENTS.md — arena-bridge contributor guide

This file is for AI agents and human contributors working on arena-bridge.
Keep it short; details go to `docs/reference/`.

## Module map

| Path | Purpose | Notes |
|------|---------|-------|
| `src/engine.mjs` `arena_bridge/engine.py` | Tool catalog + `Engine.call()` gate | Approval, trust, audit pipeline. Node is canonical, Python is shim. |
| `src/policy.mjs` `arena_bridge/policy.py` | `resolveTarget`/`checkPath` + `isInside` | lstat-based symlink handling (B1). Single source for path policy. |
| `src/config.mjs` `arena_bridge/config.py` | `loadConfig`/`saveConfig` + `DEFAULTS` | `config.json` = user intent, `state.json` = runtime. Atomic tmp+rename. |
| `src/audit.mjs` `arena_bridge/audit.py` | `audit()`/`tailAudit()`/`readArtifact()` | JSON-lines, reverse-read, 5–10MB rotation, no large bodies. |
| `src/approvals.mjs` `arena_bridge/approvals.py` | `requestApproval()` file-based | 400ms poll, TTL vs wait, `trust.json` blanket window. |
| `src/trust.mjs` `arena_bridge/trust.py` | `trustState()`/`trustAllows()` | Blanket `tools:[]` = all tools. |
| `src/direct.mjs` `arena_bridge/server.py` | HTTP API (`/call`, `/files`, `/health`) | `PUT/DELETE /files` via gate + audit. 202 for pending. `/health` → `pending_approvals`, `trust_active`. |
| `src/browser.mjs` `arena_bridge/browser.py` | `BrowserManager` + CDP | Plain launch for login, DevTools keepalive, `chrome_activate`. |
| `src/mac.mjs` `arena_bridge/mac.py` | Peekaboo desktop control | Screen, mouse, keyboard, app control. |
| `src/telegram.mjs` `arena_bridge/telegram.py` | Poller + `allowedChat` filter | Prompt-injection guard, inbox `readInbox()`. |
| `src/cli.mjs` `arena_bridge/cli.py` | CLI commands (`init`, `setup`, `tunnel`, `doctor`) | `parseArgs` handles `-n`/`--n`, `doctor --json`, `config get/set/edit`, `completion bash/zsh/fish`. |
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
