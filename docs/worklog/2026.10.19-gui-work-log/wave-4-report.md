# Wave 4 report — controls

Branch `wave-4/controls` (commit `7bd9958`, on top of wave 3). Not released.

## Built
- Start and Stop run numbered steps (6 for start, 4 for stop). The toggle is disabled during a transition.
- The indicator sits to the right of the toggle and shows the current step, the running state, or the failure step and reason.
- Each step is written to the work log as a service step. A failure is written with the alert level.
- The app menu Start and Stop use the same steps.
- Setup and Copy the agent prompt sit at the trailing edge.
- A status refresh does not change the state during a transition.
- Build on macOS 15.7 via `build.sh`: passes.

## Not verified
- Start and Stop were not run from the app; the live stop test is part of wave 5.
- The indicator is not clickable yet (planned jump to the failing log row is not built).

## Known limits
- "Waiting for the public address to close" checks for any running cloudflared process, not only the bridge's own.
