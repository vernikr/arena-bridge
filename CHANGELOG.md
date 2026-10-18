# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/) and the project uses
[Semantic Versioning](https://semver.org/).

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
