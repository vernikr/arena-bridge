# Security

Boundaries: `audit_artifact` basename+isInside, `search_files`/`list_dir` per-element `checkPath`+symlink `lstat→readlink`, `PUT/DELETE /files` with audit (no approval gate), `allowedChat` before inbox/approve, token `timingSafeEqual`/`compare_digest`, `edit_file` UTF-8 literal `$&` atomic `tmp+rename`.

Access: there is no trust window and no approval gate — if the service is running, everything is allowed (token auth + path policy still apply).

State (`~/.arena-bridge/state.json`) holds runtime: `publicUrl`, service status. Atomic `tmp+rename`, migrated from `config.json` if present (B7/B12 fix).
