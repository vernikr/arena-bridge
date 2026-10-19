# Work log record contract (v2)

One JSON object per line in `audit.log`. Version 1 fields are kept; v2 adds the fields below.
Fixture with one example per kind: `fixtures/audit-v2.jsonl`.

| Field | Type | Rule |
|---|---|---|
| `id` | string | Unique, sortable by time. Used for cursors and artifact folders. |
| `ts` | string | UTC ISO 8601 with milliseconds. Display is local. |
| `level` | `info` \| `notice` \| `warning` \| `alert` | See plan section 3.4. |
| `kind` | `call` \| `note` \| `approval` \| `trust` \| `service` \| `tunnel` \| `auth` \| `log` | Event family. |
| `tool` | string \| null | Tool name for `call`/`note`; null otherwise. |
| `status` | string | `ok`, `error`, `exception`, `rejected`, `approval_denied`, `opened`, `closed`, `expired`, `step`, `started`, `stopped`, `gave_up`, `unauthorized`, `history_deleted`. |
| `duration_ms` | number | Present for calls and steps; 0 otherwise. |
| `via` | string | For calls: authorization path `direct`, `trust_window`, `approval`, `files_api`, `api`. For lifecycle events: origin `gui`, `cli`, `telegram`, `app-launch`, `tunnel`. |
| `actor` | `agent` \| `user` \| `system` | Who initiated. |
| `source` | object | `channel` (`http`, `mcp`, `hub`, `local`, or lifecycle origin), `ip` (from the tunnel's `Cf-Connecting-IP`), `country`, `host` (reverse DNS), `client` (User-Agent, 120 chars), `alias`. Informational only; authorization never depends on it. Null when unknown. |
| `args` | object | Parameters after secret masking. Inline up to 64 KB. |
| `args_truncated` | bool | True when the full value lives in the artifact named by `args_artifact`. |
| `args_artifact` | string? | File name of the full arguments in the entry's artifact folder. |
| `error` | string \| null | Machine code when present (e.g. `UNKNOWN_TOOL`). |
| `artifacts` | array | Screenshots and trees, unchanged from v1. |

Retention (decided 2026-10-19): audit log kept 7 days and at most 20 MB; artifacts kept 7 days and at most 200 MB in total, oldest removed first.
