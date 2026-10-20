"""Unified error codes — Python mirror of src/errors.mjs"""

ERROR_CODES = {
    "PROTECTED": {"message": "path is invalid or inside a protected location", "hint": "check protected paths in config and macOS permissions", "retryable": False},
    "INVALID_PATH": {"message": "path is required or malformed", "hint": "provide absolute path or ~/", "retryable": False},
    "NOT_FOUND": {"message": "file or directory not found", "hint": "list_dir to see available paths", "retryable": False},
    "IS_DIR": {"message": "path is a directory, expected file", "hint": "use list_dir for directories", "retryable": False},
    "NOT_DIR": {"message": "not a directory", "hint": "check path is directory", "retryable": False},
    "APPROVAL_DENIED": {"message": "human denied the action", "hint": "do not retry, ask user what to do", "retryable": False},
    "APPROVAL_PENDING": {"message": "approval wait ended without decision", "hint": "open trust window: arena-bridge trust --for 1h, then retry once", "retryable": True},
    "UNAUTHORIZED": {"message": "missing or invalid Authorization Bearer token", "hint": "use Authorization: Bearer <token> header", "retryable": False},
    "FORBIDDEN": {"message": "forbidden", "hint": "approvals require local token", "retryable": False},
    "TIMEOUT": {"message": "command timed out", "hint": "increase timeout_sec or check process", "retryable": True},
    "PAYLOAD_TOO_LARGE": {"message": "payload exceeds maxUploadBytes", "hint": "reduce file size or increase limit", "retryable": False},
    "INVALID_JSON": {"message": "invalid JSON body", "hint": "check JSON syntax", "retryable": False},
    "UNKNOWN_TOOL": {"message": "unknown tool", "hint": "GET /tools for catalog", "retryable": False},
}

def error_response(code, **extra):
    defn = ERROR_CODES.get(code, {"message": code, "hint": "", "retryable": False})
    return {
        "ok": False,
        "error": code,
        "code": code,
        "message": extra.get("message", defn["message"]),
        "hint": extra.get("hint", defn["hint"]),
        "reason": extra.get("reason", extra.get("message", defn["message"])),
        "retryable": extra.get("retryable", defn["retryable"]),
        **extra,
    }
