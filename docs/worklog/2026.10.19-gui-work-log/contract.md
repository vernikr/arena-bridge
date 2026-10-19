# Work log record contract (v2)

One JSON object per line in `audit.log`. Version 1 fields are kept; v2 adds the fields below.
Fixture with one example per kind: `fixtures/audit-v2.jsonl`.

| Field | Type | Rule |
|---|---|---|
| `id` | string | Unique, sortable by time. Used for cursors and artifact folders. |
| `ts` | string | UTC ISO 8601 with milliseconds. Display is local. |
| `level` | `info` \| `notice` \| `warning` \| `alert` | See plan section 3.4. |
| `kind` | `call` \| `note` \| `approval` \| `trust` \| `service` \| `tunnel` \| `auth` \| `log` \| `step` | Event family. `log` is history management (decision 1, pending). |
| `tool` | string \| null | Tool name for `call`/`note`; null otherwise. |
| `status` | string | `ok`, `error`, `exception`, `rejected`, `approval_denied`, `opened`, `closed`, `expired`, `step`, `started`, `stopped`, `gave_up`, `unauthorized`, `history_deleted`. |
| `duration_ms` | number | Present for calls and steps; 0 otherwise. |
| `via` | string | For calls: authorization path `direct`, `trust_window`, `approval`, `files_api`, `api`. For trust events: origin `launch` (auto-open at start), `cli`, `gui`, `approval`, `expiry`, `external` (a change made by another writer such as the app). For service events: `launchd` or `cli`. For `step`: `gui`. |
| `actor` | `agent` \| `user` \| `system` | Who initiated. |
| `source` | object | `channel` (`http`, `mcp`, `hub`, `local`, or lifecycle origin), `ip` (from the tunnel's `Cf-Connecting-IP`), `country`, `host` (reverse DNS), `client` (User-Agent, 120 chars), `alias`. Informational only; authorization never depends on it. Null when unknown. |
| `args` | object | Parameters after secret masking. Inline up to 64 KB. |
| `args_truncated` | bool | True when the full value lives in the artifact named by `args_artifact`. |
| `args_artifact` | string? | File name of the full arguments in the entry's artifact folder. |
| `error` | string \| null | Machine code when present (e.g. `UNKNOWN_TOOL`). |
| `artifacts` | array | Screenshots and trees, unchanged from v1. |

Trust events: `status` is `open`, `extend` (later end time), `change`, `close` or `expire`. Each change is logged once, whichever writer made it. `reason` is `manual`, `expired` or `external`. Expiry is written by the bridge when the end time passes.

Lifecycle events: `kind:"service"`, `tool:"bridge"`, `status` `start` or `stop` (with `reason`, `pid`, `version`, `port`). `kind:"tunnel"`, `tool:"tunnel"`, `status` `up` (with `url` host) or `down` (with `code`). A process killed with SIGKILL writes no stop event.

Storage: the active file rotates at 5 MB into `audit-<ms>.log`. Retention (decided 2026-10-19): audit log kept 7 days and at most 20 MB across all segments; the newest archive is never removed; artifacts kept 7 days and at most 200 MB in total, oldest removed first.
