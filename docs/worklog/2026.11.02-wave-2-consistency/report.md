# Wave 2 — input and lifecycle consistency

Release target: `0.19.0`.

## Implemented

- Added shallow JSON-schema validation for every tool call using the same catalog schemas exposed through `/tools` and MCP.
- Invalid required fields, types, and unknown properties now return a structured `INVALID_ARGS` response before approvals or handlers run.
- Expanded `config validate` to cover runtime mode, host and port, URLs, tokens, limits, timeouts, path arrays, tunnel settings, Telegram settings, and malformed config files.
- Added `DEVICE_BUSY` as a retryable unified error for bounded hub queues.
- Added hub health fields and read-only `/config`, `/audit`, `/audit/entry`, `/audit/artifact`, and approval polling routes to match direct mode.

## Verification

- Added end-to-end checks for malformed tool arguments, config validation, and hub endpoint parity.
- Node smoke suite: 48 checks passed.

## Next wave

Proceed to platform and maintenance quality: remove remaining Swift compiler warnings, expand supported-runtime matrix coverage, and test interrupted config/state writes.
