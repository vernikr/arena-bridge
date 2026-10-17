# 2026.10.18 — desktop control, listing fix, packaging

## Goal
Let the cloud agent inspect and control the machine end to end: Chrome (done in 0.4.0), the
macOS desktop, and no per-call confirmations when the user opens a trust window. Ship the
result as a self-contained, one-command-install artifact on GitHub and npm.

## Findings from the live run
- The agent listed `/Users/vernikr/projects` and saw two folders, while the user has many more.
  Cause: `list_dir` always recursed one level (`depth === 0` in the condition), so the answer
  mixed the top level with the content of the first folders. Fixed: top level only by default,
  `recursive`/`depth` opt-in, `lstat` instead of `stat`, unreadable directories reported.
- `bash` appeared to hang. Cause: the call waits for a local approval, and the answer only
  arrived after the wait expired, so the agent could not tell "waiting" from "broken". Fixed:
  the answer is now `APPROVAL_PENDING` with the `approval_id` and the exact command to run.
- `arena-bridge trust --for 2h` crashed with `trustState is not defined` — the Node CLI never
  imported the trust helpers. Fixed and covered by a test.

## Delivered
- 13 `mac_*` tools over the Peekaboo CLI (screen capture with element ids, mouse, keyboard,
  scrolling, drag, applications, windows, permission check). Node and Python.
- `arena-bridge setup` — config, doctor, API, tunnel and prompt in one command.
- `arena-bridge update` — self-update from the npm registry; `version`, `url`, `service`.
- Launchd service so the bridge survives reboots.
- README with a cover, quick start, tool map and a troubleshooting table; CHANGELOG, SECURITY,
  CI for Node and Python on Linux and macOS.

## Release
0.5.0 — npm (`arena-bridge`), GitHub (`vernikr-personal/arena-bridge`, private), PyPI.
