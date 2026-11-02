# Wave 3 — platform and maintenance quality

## Implemented

- Removed all warnings from the local macOS app build: modernized the scene-phase callback and made detached task results and closures explicit.
- Added recovery for interrupted atomic config and runtime-state writes: a valid `.tmp` replacement is promoted when the primary JSON file is incomplete.
- Added smoke coverage for recovery of both config and state files.
- Expanded the Node CI matrix to Node 18, 20, and 24 on Ubuntu and macOS.

## Verification

- Node smoke suite: 48 checks passed.
- Full Node suite: passed.
- Python suite: passed.
- macOS app build: passed with no compiler warnings.

## Release

Release target: `0.19.1`.
