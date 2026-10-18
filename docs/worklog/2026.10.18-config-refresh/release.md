# Configuration refresh — 0.7.20

## Scope

Configuration is now loaded consistently at the HTTP request boundary and before tool execution
in both runtimes. Authentication, roots, protected paths, approval policy, response limits,
`/config`, `/prompt`, `/files`, `/call`, `/exec` and MCP calls no longer mix an old server snapshot
with a refreshed engine snapshot.

## Verification

- `npm test`: passed, including Node approval, HTTP, browser, desktop and service checks.
- `npm run test:python`: passed on Python 3.9, including the new `/call`, `/files` and `/config` refresh check.
- `npm run pack:check`: passed.
- `git diff --check`: passed.
- No local service reinstall or permissions changes were performed.
