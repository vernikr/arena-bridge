# Approval lifecycle fix — 0.7.19

## Scope

Updated from origin/main at f660a88. Closed approval requests must not remain actionable.
Node and Python persist timeout/expiry, reject late decisions, and expire stale pending
records when listing or deciding them. A failed late decision cannot open a trust window.
The existing APPROVAL_PENDING response code is retained for client compatibility; recovery
hints and generated agent prompts explain that timeout/expired IDs are closed.

Explicit Peekaboo paths are authoritative in both runtimes. This also makes the existing
missing-binary checks independent of other Peekaboo installations on the test machine.

## Verification

- `npm test`: approval unit tests, HTTP integration, browser/desktop fixtures and service checks passed.
- `npm run test:python`: equivalent Python checks passed on Python 3.9.
- `node test/telegram.test.mjs` and `python3 test/test_telegram.py`: passed.
- New isolated unit suites cover zero wait, zero TTL, stale records, late decisions,
  trust-window rejection and valid approve/deny decisions.
- `git diff --check`: passed.

## Publication

Planned tag: v0.7.19. Verify CI, npm, PyPI and all five GitHub Release assets before marking complete.
No local service reinstall or permissions changes are part of this task.
