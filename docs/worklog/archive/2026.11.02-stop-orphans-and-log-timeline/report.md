# Stop orphans and the work-log timeline — 2026-11-02

## Symptom
- Stop failed at step 3/4: "public address still open after 10 s", while the cloud agent
  lost the machine: the public address answered with a tunnel error.
- The work log could show older rows after newer ones.

## Root causes
- `startTunnel` returned the first spawned child; after an automatic tunnel restart the
  stop path killed a corpse and orphaned the live tunnel, which kept the public address
  open against a dead local API.
- launchd may SIGKILL the service helper; the bridge then survived as an orphan with its
  tunnel, kept the API port, and a raw `launchctl bootout` could not reach it. The app
  read launchctl output, not its exit code, so failures looked like successes.
- The stop confirmation matched any process whose command line contained `cloudflared`,
  including the bridge itself (`--bin cloudflared`).
- The app advanced its log cursor by the end of the active log file; a rotation between
  two reads moved that cursor into another segment and returned older records after
  newer ones. Local fallback rows written while the service was down arrived out of
  order as well.

## Fix
- The tunnel object exposes the live child; stop kills what is alive. Pid files for the
  bridge and the tunnel let the next generation retire orphans; `arena-bridge stop`
  (used by the app) stops service, API and orphaned tunnels of this bridge only.
- The bridge shuts down when its parent process disappears, so a SIGKILLed helper or a
  closed terminal cannot leave an orphan.
- launchctl results carry the exit code; the app treats a failed bootout as a failure.
- The tunnel check reads the pid file, falling back to exact tunnel binary names.
- The app follows the bridge cursor (segment + byte), pages until caught up, refills
  after a reset, and renders the log as a timeline regardless of arrival order.
- `/health` reports the live tunnel (`public_url`, `tunnel_alive`); spent tunnel restarts
  unpublish the stored public URL instead of advertising a dead address.

## Verified
- `npm test` and `npm run test:python` pass; new `test/tunnel.test.mjs` covers the pid
  file lifecycle and port-exact tunnel cleanup.
- macOS app build runs in CI (macos-app job) with the release.
