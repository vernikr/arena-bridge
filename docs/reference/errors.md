# Error codes

Single source: `src/errors.mjs` `ERROR_CODES` → `errorResponse(code)` → HTTP `error`/`hint`/`retryable` in `POST /call` and `/files`.

| code | message | hint | retryable |
|---|---|---|---|
| `PROTECTED` | path is outside authorized roots or inside protected location | check roots/protected in config, use arena-bridge doctor | false |
| `INVALID_PATH` | path is required or malformed | provide absolute path or ~/ | false |
| `NOT_FOUND` | file or directory not found | list_dir to see available paths | false |
| `IS_DIR` | path is a directory, expected file | use list_dir for directories | false |
| `NOT_DIR` | not a directory | check path is directory | false |
| `APPROVAL_DENIED` | human denied the action | do not retry, ask user what to do | false |
| `APPROVAL_PENDING` | approval wait ended without decision | open trust window: arena-bridge trust --for 1h, then retry once | true |
| `UNAUTHORIZED` | missing or invalid Authorization Bearer token | use Authorization: Bearer <token> header | false |
| `FORBIDDEN` | forbidden | approvals require local token | false |
| `TIMEOUT` | command timed out | increase timeout_sec or check process | true |
| `PAYLOAD_TOO_LARGE` | payload exceeds maxUploadBytes | reduce file size or increase limit | false |
| `INVALID_JSON` | invalid JSON body | check JSON syntax | false |
| `UNKNOWN_TOOL` | unknown tool | GET /tools for catalog | false |
| `INVALID_ARGS` | arguments are missing or malformed | check the tool schema in GET /tools | false |
| `RATE_LIMITED` | too many calls in a short time | wait a second and retry | true |

Agent mapping: `PROTECTED`/`NOT_FOUND`/`IS_DIR` = policy, `APPROVAL_DENIED`/`PENDING` = gate, `TIMEOUT` retry with backoff, `UNKNOWN_TOOL` → `GET /tools`, `RATE_LIMITED` wait a second.
