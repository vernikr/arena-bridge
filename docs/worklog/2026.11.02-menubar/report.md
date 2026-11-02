# Menubar service control

## Implemented

- Added a menubar item with Lucide-style link-2 and link-2-off vector icons.
- Added a three-dot transition indicator for start and stop operations.
- Added Start/Stop, Copy Prompt, Open, and Quit actions to the menubar menu.
- Added main-window lifecycle handling: closing the main window switches the app to accessory mode so it leaves the Dock while the menubar item remains available.
- Reopening the app from the menubar restores the regular activation policy and main window.

## Verification

- macOS app build passed with no compiler warnings.
- Menubar feature release: `0.20.0`.
- Follow-up patch target: `0.20.1` for installer initialization and the macOS service restart target discovered during deployment.
- Follow-up patch target: `0.20.2` for explicit menubar icon coloring after visual verification.
- Follow-up patch target: `0.20.3` for native macOS label-color rendering in the Canvas icon.
- Follow-up patch target: `0.20.4` for a native `NSImage` template renderer in `MenuBarExtra`.
- Follow-up patch target: `0.20.5` for automatic use of the stable local signing certificate.
- Follow-up patch target: `0.20.6` for a non-animated menubar transition icon and non-blocking service checks.
