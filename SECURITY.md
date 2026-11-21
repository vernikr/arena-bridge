# Security policy

## Threat model

`arena-bridge` gives a remote AI agent access to a machine. The package is designed so that a
compromise of the agent, of the chat or of the tunnel does not automatically become a compromise
of the machine.

## What protects the machine

- **Localhost only.** The server binds `127.0.0.1` by default. Public access requires an explicit
  tunnel.
- **Three separate tokens.** The agent token can only call tools, the device token only connects
  a device to a hub, and the local token settles historical approval requests. The agent never
  receives the local token and cannot approve its own requests.
- **Path policy.** Every file operation is limited to the configured `roots`. A protected list
  (`~/.ssh`, `~/.aws`, `~/.arena-bridge`, browser profiles, credential files) is denied even
  inside a root.
- **No approval gate, no trust window.** If the service is running, everything is allowed:
  side-effecting tools run without human confirmation. Token auth and the path policy below
  are the only gates.
- **Audit log.** Every call is appended to `~/.arena-bridge/audit.log` (0600) with the tool, the
  arguments and the outcome.

## Reporting a vulnerability

Please report issues privately to the repository owner instead of opening a public issue.
