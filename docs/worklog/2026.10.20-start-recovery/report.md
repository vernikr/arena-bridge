# Start recovery: lessons from the first real start on a user Mac

## What happened
- The start stopped at "Starting bridge". The service manager (launchd) returned status 78 (configuration error) and the start command did not return. The app waited with no limit.
- The work log was empty, because the start steps were written through the bridge, which was not running.
- Setup showed macOS prompts to open System Settings. Permission checks ran every 6 to 10 seconds, because the app checked on every window focus and on every guide opening without spacing.

## Changes (0.16.x)
- Every service command has a time limit; a stuck command is killed and reported as a step failure.
- A start that does not answer reloads the service once before it fails.
- The start has seven steps, each with a time limit, and a Cancel button.
- Step lines stay in the app's own log while the bridge is down.
- Permission checks are spaced: 10 s for explicit checks, 60 s for the rest.

## Open
- Find the cause of status 78 on the user's machine (service definition or executable path). Capture it in the start log.
- The app's own permission checks still appear in the work log as tool calls from 127.0.0.1. Mark them as internal so they do not hide agent calls.
- Confirm which action opens the System Settings prompt during Setup (text of the prompt is needed).

## Rules for the next waves
- Any action that can show a macOS prompt is user-initiated or spaced, never periodic.
- A background step must have a time limit and a visible reason when it stops.
- Start and stop write their steps to a place that works without the bridge.
