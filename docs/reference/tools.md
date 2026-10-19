# Tools

Single source: `src/engine.mjs` `toolCatalog()` → `GET /tools` + MCP `tools/list` + `prompt` + `README`.

## core (16)

- `bash`
- `read_file`
- `write_file`
- `edit_file`
- `list_dir`
- `search_files`
- `delete_path`
- `file_get`
- `file_put`
- `audit_log`
- `audit_artifact`
- `sysinfo`
- `start_process`
- `read_process_output`
- `write_process`
- `kill_process`

## browser (0)


## desktop (0)


## telegram (3)

- `notify_user`
- `telegram_inbox`
- `telegram_status`

All 52+ tools share `{ok, error:{code,message,hint,retryable}}` via `src/errors.mjs`.
