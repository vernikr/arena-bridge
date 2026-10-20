// Unified error codes — single source of truth for agent error handling
// Generated from policy, engine, and http layers. Use via errorResponse()

export const ERROR_CODES = {
  PROTECTED: { message: 'path is invalid or inside a protected location', hint: 'check protected paths in config and macOS permissions', retryable: false },
  INVALID_PATH: { message: 'path is required or malformed', hint: 'provide absolute path or ~/', retryable: false },
  NOT_FOUND: { message: 'file or directory not found', hint: 'list_dir to see available paths', retryable: false },
  IS_DIR: { message: 'path is a directory, expected file', hint: 'use list_dir for directories', retryable: false },
  NOT_DIR: { message: 'not a directory', hint: 'check path is directory', retryable: false },
  APPROVAL_DENIED: { message: 'human denied the action', hint: 'do not retry, ask user what to do', retryable: false },
  APPROVAL_PENDING: { message: 'approval wait ended without decision', hint: 'open trust window: arena-bridge trust --for 1h, then retry once', retryable: true },
  UNAUTHORIZED: { message: 'missing or invalid Authorization Bearer token', hint: 'use Authorization: Bearer <token> header', retryable: false },
  FORBIDDEN: { message: 'forbidden', hint: 'approvals require local token', retryable: false },
  TIMEOUT: { message: 'command timed out', hint: 'increase timeout_sec or check process', retryable: true },
  PAYLOAD_TOO_LARGE: { message: 'payload exceeds maxUploadBytes', hint: 'reduce file size or increase limit', retryable: false },
  INVALID_JSON: { message: 'invalid JSON body', hint: 'check JSON syntax', retryable: false },
  UNKNOWN_TOOL: { message: 'unknown tool', hint: 'GET /tools for catalog', retryable: false },
  INVALID_ARGS: { message: 'arguments are missing or malformed', hint: 'check the tool schema in GET /tools', retryable: false },
  RATE_LIMITED: { message: 'too many calls in a short time', hint: 'wait a second and retry', retryable: true },
};

export function errorResponse(code, extra = {}) {
  const def = ERROR_CODES[code] || { message: code, hint: '', retryable: false };
  return {
    ok: false,
    error: code,
    code,
    message: extra.message || def.message,
    hint: extra.hint || def.hint,
    reason: extra.reason || extra.message || def.message,
    retryable: extra.retryable ?? def.retryable,
    ...extra,
  };
}

export function isErrorCode(v) { return typeof v === 'string' && v in ERROR_CODES; }
