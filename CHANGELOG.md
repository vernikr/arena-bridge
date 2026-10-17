# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/) and the project uses
[Semantic Versioning](https://semver.org/).

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
