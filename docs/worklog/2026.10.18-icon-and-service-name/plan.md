# The icon, the service name and the name of the app (0.7.13)

## Goal

Three things the user noticed: the app icon turned into a white sheet, the background service
in the system settings is called "node", and the name of the app is scattered in many places.

## What was built

- `tools/make-icon.py` cuts the flat picture into an icon: everything outside the shape becomes
  transparent, the edge stays soft. The result is `Resources/AppIcon.png` (1024×1024, RGBA) and
  every `.icns` built from it keeps the alpha.
- The launchd agent starts a small script `~/.arena-bridge/Arena Bridge` instead of the node
  binary, so the system settings show the name of the app.
- The name of the app is a constant: `src/app.mjs`, `arena_bridge/app.py` and
  `Sources/AppInfo.swift`. The build takes the name and the bundle id from the Swift file and
  writes them into `Info.plist`. A test checks that the three constants are the same.

## The configuration that was overwritten

A test run on the user's Mac wrote the test configuration over `~/.arena-bridge/config.json`:
the agent token became `test-token`, the roots pointed at a temporary folder and Telegram was
off. The configuration was restored with the previous token, the previous roots
(`~/projects`, `~/Documents`) and the Telegram link.

Every test now checks that the configuration it touches lives in a temporary folder, so a test
run can never touch the real one again.

## Live check on the user's Mac

- The command line is 0.7.13, the app 0.3.0 with the new icon; the Dock shows the icon without
  a white background.
- `sfltool dumpbtm` lists the login item as "Arena Bridge" with the path
  `~/.arena-bridge/Arena Bridge`.
