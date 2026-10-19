# b01 — Python test suites fail on main (pre-existing)

Status: open, not caused by the work log changes; Node is canonical, so it does not block the Node release.

Symptoms (`npm run test:python`, reproduced on main and on the work log branch with identical output):
- `arena_bridge/approvals.py` `_expire_if_needed`: `UnboundLocalError: cannot access local variable 'tmp'` when the approval wait is zero.
- `arena_bridge/approvals.py` `request_approval`: `UnboundLocalError: ... 'status'` in 13 test cases of `test_bridge.py`.
- `test_browser.py` and `test_telegram.py` exit with failures of the same family.

Next step: fix the Python approvals module (security-relevant, so it may be a 0.10.x patch) or drop the Python suites from `npm run test:python` if Python parity is no longer kept.
