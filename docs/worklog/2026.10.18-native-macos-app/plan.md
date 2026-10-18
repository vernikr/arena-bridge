# Native macOS app (0.1.0)

## Goal

One window for everything the user needs from the bridge: first-time setup, start, stop,
status, approvals and the work log. No menubar icon — an ordinary app window.

## What was built

`macos/ArenaBridge` — SwiftUI, four files, no dependencies:

- `App.swift` — the scene, the menu commands, the window.
- `Bridge.swift` — the config reader, the local API client, the launchd service control.
- `Model.swift` — the state the window shows and every action it can take.
- `Views.swift` — the status, control, approvals and log cards, plus the setup sheet.

The app talks to the local API on `127.0.0.1:8787`, reads `~/.arena-bridge/config.json` and
drives the launchd service `ai.arena.bridge` through `launchctl`. It never talks to the
internet and it writes nothing outside the bridge config and the log.

## Build

`./build.sh` compiles with `swiftc` into `dist/Arena Bridge.app` — the Xcode command line
tools are enough, no project file, no package manager.

## Live check

Built and launched on the user's Intel Mac: the window shows the running state, the public
address, the pending approvals and the log; the Approve button settles a request through the
local API.

## Released with it

- 0.7.3 — `mac_scroll` speaks the current Peekaboo grammar (`--amount` instead of the
  removed `--ticks`).
