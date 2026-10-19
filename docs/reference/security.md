# Security

Boundaries: `audit_artifact` basename+isInside, `search_files`/`list_dir` per-element `checkPath`+symlink `lstat→readlink`, `PUT/DELETE /files` via `authorize()`+audit, `allowedChat` before inbox/approve, token `timingSafeEqual`/`compare_digest`, `edit_file` UTF-8 literal `$&` atomic `tmp+rename`.

Trust: blanket `tools:[]` = all tools, `for` without `tools` is error, `tools+paths` = intersection, `bash` not covered by `--paths` alone, `Approve for 3h` adds window (not overwrite).
