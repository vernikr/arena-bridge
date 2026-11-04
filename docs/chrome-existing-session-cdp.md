# Attach to an existing multi-profile Chrome session

This guide records a manually verified way to control tabs in an already-running
Chrome instance, including tabs opened under multiple Chrome profiles, through
one browser-level Chrome DevTools Protocol (CDP) connection.

It is an operational recipe for an authorized local automation client. It is
not currently implemented by `arena-bridge chrome_attach`: that command
currently discovers CDP through `http://127.0.0.1:<port>/json/version`.

## When to use it

Use this path when all of the following apply:

- Chrome is already running with the user's authenticated profiles and tabs.
- The user has explicitly approved remote debugging and the local automation.
- The regular CDP HTTP discovery endpoint is unavailable, while Chrome has
  written a `DevToolsActivePort` file in its user-data directory.
- The automation client can read that local file and open a WebSocket.

Do not launch another Chrome instance or restart the existing one just to try
this path. Preserve open tabs and profile state.

## Connection flow

1. Locate the active Chrome user-data directory from the running process or
   another authoritative local source. Do not infer it from a profile's
   friendly display name.
2. Read `DevToolsActivePort` from the user-data directory. Its first line is
   the local debugging port; its second line is the browser WebSocket path.
3. Connect to `ws://127.0.0.1:<port><websocket-path>`. Keep the endpoint on
   localhost. Reuse this browser-level WebSocket for the entire operation.
4. Call `Target.getTargets` and filter for `type === "page"`. Identify each
   requested tab by its URL and title, rather than assuming the first or active
   tab is the target.
5. For each target, call `Target.attachToTarget` with `flatten: true`. Keep
   the returned session ID and pass it with subsequent page commands.
6. Before interacting with a tab, call `Page.bringToFront` for its session.
   Wait for the page and the relevant interface to finish initializing.
7. Perform the smallest requested interaction and verify its result.

A single browser-level target list can include page targets belonging to
multiple Chrome profiles in the same running browser instance. Profile identity
must still be established from the actual target URL/title and the user's
requested mapping.

## Text entry and form submission

For Arena composers and other controlled text fields:

1. Inspect the current field value and confirm that the intended composer is
   visible and ready.
2. Focus the field and explicitly clear any existing text (for example,
   select all and delete).
3. Insert the requested text exactly once.
4. Read the field value back and compare it byte-for-byte with the intended
   text. Stop if it differs or if the Send button is disabled.
5. Submit only after the exact value is confirmed, then verify the resulting
   conversation content.

Do not combine a DOM value assignment with a later `Input.insertText` call:
the latter appends to the former and can create duplicate text. Do not retry a
submission just because the UI is slow; first inspect the conversation and
composer to determine whether the first attempt succeeded.

For file uploads, inspect the page's file input and use the browser protocol's
file-input mechanism where available. This can avoid opening a native Finder
dialog. Verify the attachment appears before submitting.

## Chrome approval prompt

Chrome may display **Allow remote debugging?** when an external client requests
debugging access. This grants broad control over the Chrome session, including
access to authenticated page content and navigation. Explain the prompt and
wait for the user to approve it. Never click through or bypass it automatically.

A reused WebSocket avoids deliberately creating a fresh client for each tab,
but this test does not establish that Chrome will suppress every future prompt.
Chrome may ask again when a new client connects.

## Current implementation boundary

`arena-bridge chrome_attach` currently accepts a CDP port and calls
`/json/version` to discover the browser WebSocket. The manually verified
workflow above reads `DevToolsActivePort` directly because, in the tested
environment, the HTTP discovery URL returned 404 while the WebSocket path in
the file worked.

This guide does not claim that `chrome_attach` can yet read that file or that
the bridge maintains one persistent connection across separate invocations.
