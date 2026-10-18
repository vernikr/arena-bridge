# Release artifacts and one-command install (0.7.6 – 0.7.10)

## Goal

Every release must produce ready-to-use artifacts, and the command line plus the macOS app
must install in one step. The Gatekeeper hint has to be short and not intrusive.

## What was built

- `.github/workflows/release.yml` — a tag `vX.Y.Z` publishes to npm and PyPI, then builds the
  release assets: the npm tarball, the sdist, the wheel and the macOS app for both
  architectures (`Arena-Bridge-arm64.zip`, `Arena-Bridge-x86_64.zip`).
- `install.sh` — one installer for both parts: `--cli-only`, `--app-only`, `--version`,
  `--prefix`. It fetches the app from the release assets and the command line from npm.
- The README gained a one-line install, direct download links for both app builds and a
  two-line Gatekeeper note (right click → Open, or `xattr -dr com.apple.quarantine`).
- `feature-tree.md` — the full map of the product: 52 tools, the connection modes, the
  approval gate, the journal, Telegram, the command line and the app.

## Fixes found while releasing

- The path policy compared a symlinked root with its real path, so on macOS every file under
  the temporary folder looked "outside the authorized roots" (11 CI failures). The roots and
  the protected paths are now resolved the same way as the target.
- The release workflow needed twine, and the macOS job must not depend on the executable bit
  of `build.sh`; the script also printed the architecture with a variable that bash could not
  parse.

## The window that follows the machine

The app used to show the state it had at the moment it opened. Now it refreshes itself: the
status, the pending approvals and the trust window every few seconds, the work log now and
then. The trust window is read straight from its file, so the line "active — 2:59 left" is
always the truth.

## Live check on the user's Mac

- The command line is 0.7.11 (`~/.local/bin/arena-bridge`), the app 0.3.0 is installed from the
  release asset and runs, the service `ai.arena.bridge` answers 200 on `/health`.
- The trust window opened for the tests is closed: every side-effecting action asks again.
