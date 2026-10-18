# The permission that slipped away and the tunnel that lost its domain (0.7.15, 0.7.16)

## What the user noticed

The switch for `node` in «Privacy & Security → Screen & System Audio Recording» was off again
after the user had turned it on, and the row was still in the list.

## Why it happened

macOS binds a permission to the exact file of a program. The version manager (fnm) keeps node in
a folder that every new shell creates and that is deleted afterwards; Peekaboo and the last
resort capture of the bridge both run from there. When the folder disappeared, macOS forgot the
permission and the switch fell off.

The service now starts from permanent folders only: the node of the permanent installation and
`~/.local/bin`. The same applies to Peekaboo, which is reachable through a permanent link.

The captures in the journal of the bridge all succeeded during that time, so nothing was
actually broken: the switch had fallen off on its own.

## The tunnel that lost the domain

While the service was reinstalled, the old ngrok process kept the reserved domain. The new
bridge could not take it, the tunnel died, and the public address answered with the error page
of ngrok. The tunnel now takes the domain back: when ngrok exits before the address appears,
only the ngrok processes that serve our domain are stopped (the other tunnels of the user are
untouched) and the tunnel is started again.

The user helped with the recovery: `pkill -f "[n]grok"` and `launchctl bootstrap`.

## Live check on the user's Mac

- The command line is 0.7.16, the service runs from `~/.local/share/fnm/node-versions/...` and
  `~/.local/bin`, the Peekaboo daemon from `~/.local/bin/peekaboo`.
- A screen capture works, the public address answers, the login item is called "Arena Bridge".
