# macOS permissions guidance

## Problem
Screen Recording and Accessibility were granted to Arena Bridge, but the bridge still reported them as missing.
Cause: the app is ad-hoc signed, and macOS ties a permission to the signature. Each rebuild changed the signature, so old grants no longer matched.

## Changes
- `arena-bridge permissions [--json]`: read-only check through the screen runtime; exit code 3 when a permission is missing.
- Control card: warning with **Fix…** when a permission is missing, checked at launch and on **Check again**.
- Guide sheet: status of both permissions, steps for the common and the hard cases, shortcuts to the System Settings panes, and a note on whether the build has a certificate.
- `build.sh`: `ARENA_SIGN_IDENTITY` selects a keychain certificate; default stays ad-hoc.
- README: "macOS permissions" section with the certificate setup.
- Tests: `test/permissions.test.mjs` covers granted, missing, and absent runtime.

## Open
- The certificate is created by the user on their Mac; the agent does not create it.
- Release downloads stay ad-hoc signed until the project has a release certificate.
