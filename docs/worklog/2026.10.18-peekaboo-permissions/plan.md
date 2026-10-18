# Peekaboo permissions resilience (0.6.9 — 0.6.10)

## Problem

After a Peekaboo update the Peekaboo Bridge host lost its macOS permissions
(Screen Recording / Accessibility / Event Synthesizing). `mac_see` returned an empty
element list, so the agent could not see the screen at all.

## What changed

### 0.6.9

- `src/mac.mjs`, `arena_bridge/mac.py`: the screenshot/element read tries the local Peekaboo
  runtime (`--no-remote`) when the bridge host reports a permission problem.
- When nothing can capture, the tool answers `ok: false`, `error: "peekaboo_failed"`, a
  readable `reason` and a `hint` that names the place to fix it, instead of returning an
  empty element list.
- `test/fake-peekaboo.sh` models a bridge host without permissions: every read fails with
  `PERMISSION_ERROR_SCREEN_RECORDING` unless `--no-remote` is used.

### 0.6.10

- The last screenshot fallback used `peekaboo image`, which was removed in Peekaboo v4;
  it now uses `see --no-elements` (plus a `--no-remote` variant).
- The permission hint explains that the local runtime inherits the grant from whatever
  starts the bridge (a launchd service inherits it from the login session, a Terminal run
  from Terminal), and names "Peekaboo Bridge" in System Settings → Privacy & Security.

## Manual step on the Mac

1. System Settings → Privacy & Security → Screen Recording → enable **Peekaboo Bridge**.
2. System Settings → Privacy & Security → Accessibility → enable **Peekaboo Bridge**.
3. Quit and reopen Peekaboo, then restart the service:
   `launchctl kickstart -k gui/$(id -u)/ai.arena.bridge`

## Tests

124 green: Node 30 + 13 + 24, Python 22 + 13 + 22.
