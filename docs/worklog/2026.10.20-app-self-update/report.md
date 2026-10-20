# App self-update (0.18.0)

## Decisions
- The release announcement carries only the version. The app then reads the download, the checksum list and the version from the official GitHub release, so a message on the channel cannot point the app at another file.
- The new app must have the same signature as the installed one (same project certificate). Unsigned or differently signed builds are refused, so permissions are not reset silently.
- The channel is `vernikr-arena-bridge-releases` on ntfy; publishing uses the `NTFY_TOKEN` secret in GitHub. Reading needs no token.
- Automatic install is on by default; the switch in the Control card turns it off.

## Checks
- Channel write and read verified with a test message `0.0.0` (ignored by the app: not newer).
- Swift compiles in CI (macos-app job) before the tag is pushed.

## Open
- The first move to 0.18.0 is manual (the running 0.16.1 has no updater).
- Bridge restarts once after the swap.
