# Wave 3 report — log panel

Branch `wave-3/log-panel` (commit `a9e85ef`). Not released; version still 0.12.0.

## Built
- Build on macOS 15.7 via `macos/ArenaBridge/build.sh`: succeeds (one pre-existing deprecation warning in `App.swift`).
- Date parsing fixed for millisecond timestamps; checked on 1 029 real audit records (the 93 unparsed lines are legacy records without an id).
- Times show in the Mac's system zone (Moscow on the test Mac).
- Rows: time, level dot, tool, status, source (reverse-DNS host or address), detail, summary.
- Level filter: All / Notice and up / Warning and up / Alerts only.
- Text filter matches tool, error and summary, using text prepared once per record.
- Clear view hides rows up to now; "Show all" restores them. Records stay in the audit log.
- Auto-follow: the list stays at the bottom only if it was already there; otherwise a "New entries" button appears.
- Click a row to open the full record from `GET /audit/entry`.
- Reads only new records via cursor; window keeps the newest 5 000 rows.
- Minimum macOS version raised from 13.0 to 15.0 (needed for scroll-position tracking).

## Not in this wave (deferred or declined)
- "Delete history" with archive: waits for decision 1 (default: view clear only).
- UTC toggle: not built (time always follows the system zone, as decided).
- "Load older" button: the window holds the newest 5 000 rows; older records remain in the audit log and API.
- Resizable panel handle: fixed height of 360 pt.

## Known limit
- If more than 500 records arrive between two refreshes, the extra records between them can be skipped until the next full reload. Not expected at current rates.

## Not verified
- Visual behaviour (auto-follow, pill, sheet) was not checked on screen; the app was built but not launched, to avoid touching the running service.
