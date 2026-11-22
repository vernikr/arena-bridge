# Tunnel resilience

Issue: https://github.com/vernikr/arena-bridge/issues/3

## Changes

- Carry configured fixed public URL into generated macOS LaunchAgent arguments, including normal service reinstall.
- Retry transient initial tunnel startup failures with bounded exponential backoff and jitter; stop immediately for missing binaries and known configuration errors.
- Add a dependency-free local/public health probe and an automatic one-minute monitor for fixed-URL deployments.
- Classify DNS, TLS, connection, Cloudflare edge, HTTP, and invalid health-response failures.
- Send a Telegram alert after three consecutive failed checks and a recovery message after service returns.
- Document the workflow, add regression tests, and bump the patch version.

## Verification

- Targeted service, tunnel, and monitor tests.
- Full Node test suite, Python suite, package dry-run, and macOS service reinstall check.

## Operational behavior

The monitor runs inside the existing Arena Bridge process, so the current LaunchAgent KeepAlive lifecycle supervises it. It does not manage or restart the separately installed named Cloudflare Tunnel. It detects public-route failures from the Mac and reports them; Cloudflare Tunnel continues to own its own reconnect behavior.
