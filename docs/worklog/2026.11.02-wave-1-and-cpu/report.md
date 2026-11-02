# CPU diagnosis and wave 1 follow-up

## Diagnosis

The reported load came from the native macOS app, not the Node bridge. A live process profile showed the app's main thread spending its time in SwiftUI `AttributeGraph` updates while rebuilding the status and work-log cards.

The cause was a refresh storm:

- a timer refreshed the whole model every four seconds;
- the bridge SSE endpoint emitted a heartbeat every three seconds;
- every heartbeat triggered another full refresh;
- each refresh made several HTTP calls, queried notification settings, and assigned published values even when they had not changed.

The result was repeated SwiftUI recomputation while the user was idle.

## Implemented wave 1

- The app refresh interval is eight seconds instead of four.
- SSE heartbeats no longer trigger a full refresh.
- Concurrent refreshes are coalesced.
- Published state changes only when the value differs; notification settings are cached for one minute.
- Hub result delivery retries transient failures and stops on an expired job.
- Timed-out queued jobs are removed from the hub queue.
- Per-device hub queues are bounded.
- Completed process sessions receive an end time and are pruned after retention.

## Verification

- Node smoke suite: 46 checks passed.
- Node syntax checks: passed.
- Native macOS app build: passed.
- Added regression coverage for result retry and process-session pruning.

## Live verification

Release `0.18.16` was installed on the connected Intel Mac together with the matching CLI, and the bridge service was restarted. The native app dropped from the reported 15–20% idle CPU to 0–1.2% during repeated measurements and 0% while idle.

## Next wave

Proceed to input and lifecycle consistency: schema validation before handlers, complete CLI configuration validation, and parity of health/audit capabilities between direct and hub modes.
