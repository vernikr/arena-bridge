import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, ensureDirs, loadConfig } from './config.mjs';

const DEFAULT_BASE = 'https://api.telegram.org';
const MAX_TEXT = 4000;
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * settings
 * ------------------------------------------------------------------ */

export function telegramSettings(cfg = {}) {
  const t = cfg.telegram || {};
  const baseUrl = String(t.baseUrl || process.env.TELEGRAM_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  return {
    enabled: !!t.enabled && !!t.botToken,
    botToken: t.botToken || null,
    chatIds: (t.chatIds || []).map((v) => String(v)),
    baseUrl,
    poll: t.poll !== false,
    apiId: t.apiId || null,
    apiHash: t.apiHash || null,
  };
}

export function telegramDir() {
  return path.join(CONFIG_DIR, 'telegram');
}

export function inboxPath() {
  return path.join(telegramDir(), 'inbox.jsonl');
}

export function statePath() {
  return path.join(telegramDir(), 'state.json');
}

function ensureTelegramDir() {
  ensureDirs();
  fs.mkdirSync(telegramDir(), { recursive: true, mode: 0o700 });
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  ensureTelegramDir();
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

/* ------------------------------------------------------------------ *
 * bot api
 * ------------------------------------------------------------------ */

export async function apiCall(cfg, method, payload = {}) {
  const s = telegramSettings(cfg);
  if (!s.botToken) {
    return {
      ok: false,
      error: 'telegram_not_configured',
      reason: 'no bot token in the configuration',
      hint: 'Run: arena-bridge telegram setup --token <bot token> --chat-id <your id>',
    };
  }
  let res;
  let data = null;
  try {
    res = await fetch(`${s.baseUrl}/bot${s.botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(90_000),
    });
    data = await res.json().catch(() => null);
  } catch (e) {
    return { ok: false, error: 'telegram_unreachable', reason: e.message };
  }
  if (!res.ok || !data || data.ok !== true) {
    return {
      ok: false,
      error: 'telegram_api_error',
      reason: data?.description || res.statusText || 'unknown error',
      code: data?.error_code,
    };
  }
  return { ok: true, result: data.result };
}

export function allowedChat(cfg, chatId) {
  const s = telegramSettings(cfg);
  return s.chatIds.includes(String(chatId));
}

const sentAt = [];

export function rateOk(limit = RATE_LIMIT, windowMs = RATE_WINDOW_MS) {
  const now = Date.now();
  while (sentAt.length && now - sentAt[0] > windowMs) sentAt.shift();
  if (sentAt.length >= limit) return false;
  sentAt.push(now);
  return true;
}

/**
 * The inline keyboard under an approval message: approve once, approve for 3 hours, deny.
 */
export function approvalKeyboard(id) {
  return [
    [
      { text: 'Approve once', callback_data: `approve:${id}` },
      { text: 'Approve for 3h', callback_data: `approve3h:${id}` },
    ],
    [{ text: 'Deny', callback_data: `deny:${id}` }],
  ];
}

/**
 * Send a text message to one of the allowed chats.
 */
export async function sendTelegram(cfg, { text, chatId, title, silent, buttons } = {}) {
  const s = telegramSettings(cfg);
  if (!s.enabled) {
    return {
      ok: false,
      error: 'telegram_not_configured',
      reason: 'Telegram is not configured for this bridge',
      hint: 'Run: arena-bridge telegram setup --token <bot token> --chat-id <your id>',
    };
  }
  const target = String(chatId ?? s.chatIds[0] ?? '');
  if (!target) {
    return { ok: false, error: 'telegram_no_chat', reason: 'no chat id configured' };
  }
  if (!allowedChat(cfg, target)) {
    return {
      ok: false,
      error: 'telegram_chat_not_allowed',
      reason: `chat ${target} is not on the allow list`,
    };
  }
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, error: 'telegram_empty_message', reason: 'the message is empty' };
  if (body.length > MAX_TEXT) {
    return {
      ok: false,
      error: 'telegram_message_too_long',
      reason: `the message is ${body.length} characters, the limit is ${MAX_TEXT}`,
    };
  }
  if (!rateOk()) {
    return {
      ok: false,
      error: 'telegram_rate_limited',
      reason: `more than ${RATE_LIMIT} messages per minute`,
    };
  }
  const text_ = title ? `${title}\n${body}` : body;
  const markup = buttons && buttons.length ? { inline_keyboard: buttons } : undefined;
  const payload = {
    chat_id: target,
    text: text_,
    disable_notification: !!silent,
    ...(markup ? { reply_markup: markup } : {}),
  };
  let res = await apiCall(cfg, 'sendMessage', payload);
  if (!res.ok && /parse entities|Markdown/i.test(res.reason || '')) {
    res = await apiCall(cfg, 'sendMessage', payload);
  }
  if (!res.ok) return res;
  return {
    ok: true,
    chat_id: res.result?.chat?.id ?? target,
    message_id: res.result?.message_id ?? null,
    sent_at: new Date().toISOString(),
  };
}

/**
 * Acknowledge a button press so Telegram stops showing the spinner.
 */
export async function answerCallback(cfg, callbackId, text = '') {
  if (!callbackId) return { ok: false, error: 'telegram_no_callback' };
  const payload = { callback_query_id: callbackId };
  if (text) payload.text = String(text).slice(0, 200);
  return apiCall(cfg, 'answerCallbackQuery', payload);
}

/**
 * Replace the text of a message and drop its keyboard.
 */
export async function editMessageText(cfg, { chatId, messageId, text } = {}) {
  if (!chatId || !messageId) return { ok: false, error: 'telegram_no_message' };
  return apiCall(cfg, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: String(text ?? ''),
    reply_markup: { inline_keyboard: [] },
  });
}

/* ------------------------------------------------------------------ *
 * inbox
 * ------------------------------------------------------------------ */

export function appendInbox(item) {
  ensureTelegramDir();
  fs.appendFileSync(inboxPath(), JSON.stringify(item) + '\n', { mode: 0o600 });
}

export function readInbox({ limit = 20 } = {}) {
  let raw = '';
  try {
    raw = fs.readFileSync(inboxPath(), 'utf8');
  } catch {
    return [];
  }
  const read = new Set(readState().read || []);
  const items = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return items.slice(-Math.max(1, limit)).map((i) => ({ ...i, read: read.has(String(i.id)) }));
}

export function markInboxRead(ids) {
  const state = readState();
  const read = new Set(state.read || []);
  for (const id of ids || []) read.add(String(id));
  state.read = [...read].slice(-500);
  writeState(state);
  return state.read.length;
}

export function inboxState() {
  const state = readState();
  let total = 0;
  try {
    total = fs.readFileSync(inboxPath(), 'utf8').split('\n').filter(Boolean).length;
  } catch {
    total = 0;
  }
  const read = new Set(state.read || []);
  return {
    total,
    unread: Math.max(0, total - read.size),
    bot: state.bot || null,
    offset: state.offset || 0,
    lastError: state.lastError || null,
  };
}

export function saveBotInfo(info) {
  const state = readState();
  state.bot = info;
  writeState(state);
}

/* ------------------------------------------------------------------ *
 * commands
 * ------------------------------------------------------------------ */

/**
 * Parse a chat command like "/approve 1234" into { cmd, args }.
 */
export function parseCommand(text) {
  const raw = String(text ?? '').trim();
  if (!raw.startsWith('/')) return null;
  const [cmd, ...rest] = raw.slice(1).split(/\s+/);
  return { cmd: cmd.toLowerCase(), args: rest.join(' ').trim() };
}

/* ------------------------------------------------------------------ *
 * poller
 * ------------------------------------------------------------------ */

/**
 * Poll the bot for incoming messages and hand them to the callback.
 * Returns a handle with stop().
 */
export function startPoller(cfg, { onMessage, onCallback } = {}) {
  const s = telegramSettings(cfg);
  if (!s.enabled || !s.poll) return null;
  let stopped = false;
  let offset = readState().offset || 0;

  const fresh = () => {
    try {
      return loadConfig();
    } catch {
      return cfg;
    }
  };

  const loop = async () => {
    if (!readState().bot) {
      const me = await apiCall(fresh(), 'getMe');
      if (me.ok) saveBotInfo(me.result);
    }
    while (!stopped) {
      try {
        const res = await apiCall(fresh(), 'getUpdates', {
          offset,
          timeout: 20,
          allowed_updates: ['message', 'callback_query'],
        });
        if (!res.ok) {
          const state = readState();
          state.lastError = res.reason || res.error;
          writeState(state);
          await sleep(res.code === 409 ? 15000 : 5000);
          continue;
        }
        const updates = res.result || [];
        if (!updates.length) {
          await sleep(400);
          continue;
        }
        for (const upd of updates) {
          offset = upd.update_id + 1;
          const state = readState();
          state.offset = offset;
          writeState(state);
          const cb = upd.callback_query;
          if (cb) {
            const item = {
              id: upd.update_id,
              callback_id: cb.id,
              data: cb.data || '',
              chat_id: cb.message?.chat?.id ?? null,
              message_id: cb.message?.message_id ?? null,
              from: cb.from?.username || cb.from?.first_name || 'unknown',
              date: cb.message?.date || null,
            };
            if (onCallback) {
              try {
                await onCallback(item);
              } catch {
                /* the callback must not kill the loop */
              }
            }
            continue;
          }
          const msg = upd.message;
          if (!msg) continue;
          const item = {
            id: upd.update_id,
            chat_id: msg.chat?.id ?? null,
            from: msg.from?.username || msg.from?.first_name || 'unknown',
            text: msg.text || '',
            date: msg.date || null,
            read: false,
          };
          appendInbox(item);
          if (onMessage) {
            try {
              await onMessage(item);
            } catch {
              /* the callback must not kill the loop */
            }
          }
        }
      } catch {
        await sleep(5000);
      }
    }
  };

  loop();
  return {
    stop() {
      stopped = true;
    },
  };
}

/* ------------------------------------------------------------------ *
 * tools
 * ------------------------------------------------------------------ */

const S = (o) => ({ type: 'object', properties: o, required: [], additionalProperties: false });

async function waitForReply(cfg, sinceId, timeoutSec) {
  const deadline = Date.now() + Math.max(1, timeoutSec) * 1000;
  while (Date.now() < deadline) {
    const items = readInbox({ limit: 20 });
    const fresh = items.find((i) => Number(i.id) > sinceId);
    if (fresh) return fresh;
    await sleep(500);
  }
  return null;
}

export function telegramTools(cfg = {}) {
  return [
    {
      name: 'notify_user',
      description:
        'Send a message to the user in Telegram. Use it to report progress, ask a question, or hand over ' +
        'a result without waiting for the chat. Set wait_for_reply to keep the call open until the user ' +
        'answers in Telegram.',
      approval: false,
      schema: S({
        text: { type: 'string', description: 'the message text (up to 4000 characters)' },
        title: { type: 'string', description: 'short first line, e.g. "Готово" or "Нужен ответ"' },
        chat_id: { type: 'string', description: 'target chat id (default: the configured one)' },
        silent: { type: 'boolean', description: 'send without a sound' },
        wait_for_reply: { type: 'boolean', description: 'wait for the user to answer in Telegram' },
        timeout_sec: { type: 'number', description: 'how long to wait for a reply (default 120, max 600)' },
      }),
      required: ['text'],
      handler: async (args, ctx) => {
        const c = ctx?.cfg || cfg;
        const sent = await sendTelegram(c, {
          text: args.text,
          chatId: args.chat_id,
          title: args.title,
          silent: args.silent,
        });
        if (!sent.ok) return sent;
        if (!args.wait_for_reply) return sent;
        const since = Math.max(0, ...readInbox({ limit: 50 }).map((i) => Number(i.id) || 0));
        const reply = await waitForReply(c, since, Math.min(600, Number(args.timeout_sec) || 120));
        if (!reply) {
          return {
            ...sent,
            reply: null,
            timed_out: true,
            hint: 'The user did not answer in Telegram. Continue without the answer or ask again later.',
          };
        }
        markInboxRead([reply.id]);
        return { ...sent, reply: { from: reply.from, text: reply.text, at: reply.date } };
      },
    },
    {
      name: 'telegram_inbox',
      description:
        'Read the messages the user sent in Telegram. Use it to pick up an answer, a file name or a ' +
        'command given outside the agent chat.',
      approval: false,
      schema: S({
        limit: { type: 'number', description: 'how many messages to return (default 20)' },
        mark_read: { type: 'boolean', description: 'mark the returned messages as read (default true)' },
      }),
      required: [],
      handler: async (args, ctx) => {
        const c = ctx?.cfg || cfg;
        const limit = Math.min(100, Number(args.limit) || 20);
        const items = readInbox({ limit });
        if (args.mark_read !== false && items.length) markInboxRead(items.map((i) => i.id));
        return { ok: true, count: items.length, messages: items };
      },
    },
    {
      name: 'telegram_status',
      description: 'Show the Telegram link: the bot, the allowed chats and how many messages are unread.',
      approval: false,
      schema: S({}),
      required: [],
      handler: async (args, ctx) => {
        const c = ctx?.cfg || cfg;
        const s = telegramSettings(c);
        if (!s.enabled) {
          return {
            ok: false,
            error: 'telegram_not_configured',
            reason: 'Telegram is not configured for this bridge',
            hint: 'Run: arena-bridge telegram setup --token <bot token> --chat-id <your id>',
          };
        }
        const st = inboxState();
        return {
          ok: true,
          bot: st.bot?.username ? `@${st.bot.username}` : null,
          bot_name: st.bot?.first_name || null,
          chat_ids: s.chatIds,
          total_messages: st.total,
          unread: st.unread,
          polling: s.poll,
          last_error: st.lastError,
        };
      },
    },
  ];
}
