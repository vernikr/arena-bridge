# Telegram link (0.7.0)

## Goal

Let the agent reach the user outside the agent chat: progress reports, questions, answers
back — and approvals, so a pending request is never a dead end.

## What was built

- `src/telegram.mjs` / `arena_bridge/telegram.py` — the Bot API client, the inbox store
  (`~/.arena-bridge/telegram/`), the rate limiter and the background poller.
- Three tools: `notify_user` (send, optionally wait for the answer), `telegram_inbox`
  (read what the user wrote), `telegram_status` (bot, chats, unread).
- The bridge announces every pending approval in the chat; `/approve <id>` and `/deny <id>`
  settle it there, `arena-bridge approve <id>` still works from the terminal.
- `arena-bridge telegram setup|test|status|inbox|poll` — the same link from the command line.

## Boundaries

- The bot token lives only in `~/.arena-bridge/config.json` (0600) — the agent cannot read it
  (the file is inside the protected paths).
- Writes are limited to the chats listed in `--chat-id`; 20 messages per minute, 4000
  characters per message.
- The user, not the agent, decides who may write: the allow list is configuration, not a tool
  argument the agent can widen.

## Live check on the user's Mac

- The bot `@vernikr_bot` is linked to the chat `190771108`; the listener runs inside the
  launchd service.
- Agent → user: `notify_user` delivered the message (`message_id 3`).
- User → agent: the reply "вижу сообщение" came back inside the tool result
  (`wait_for_reply: true`).
- Approval from Telegram: the bridge asked in the chat, the user answered `/approve <id>`,
  the pending `bash` call went through (`decidedBy: telegram`).

## Follow-ups released with it

- 0.7.1 — the long poll got a generous ceiling, so a slow network does not stop the listener.
- 0.7.2 — the audit log masks credentials (Telegram, GitHub, npm, PyPI, API keys).

## Tests

149 green: Node 30 + 13 + 24 + 13, Python 22 + 13 + 22 + 12.
