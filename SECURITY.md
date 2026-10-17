# Security policy

## Threat model

`arena-bridge` gives a remote AI agent access to a machine. The package is designed so that a
compromise of the agent, of the chat or of the tunnel does not automatically become a compromise
of the machine.

## What protects the machine

- **Localhost only.** The server binds `127.0.0.1` by default. Public access requires an explicit
  tunnel.
- **Three separate tokens.** The agent token can only call tools, the device token only connects
  a device to a hub, and the local token approves requests. The agent never receives the local
  token and cannot approve its own requests.
- **Path policy.** Every file operation is limited to the configured `roots`. A protected list
  (`~/.ssh`, `~/.aws`, `~/.arena-bridge`, browser profiles, credential files) is denied even
  inside a root.
- **Approval gate.** Side-effecting tools wait for a human decision. The answer identifies the
  pending approval so the user can approve it with `arena-bridge approve <id>`.
- **Trust windows are local.** Only the local CLI can open one, and it never weakens the path
  policy — it only removes the approval requirement.
- **Audit log.** Every call is appended to `~/.arena-bridge/audit.log` (0600) with the tool, the
  arguments and the outcome.

## Reporting a vulnerability

Please report issues privately to the repository owner instead of opening a public issue.
