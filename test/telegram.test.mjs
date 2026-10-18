/**
 * The Telegram link: the agent can message the user, read what the user writes
 * back, and the user can settle a pending approval straight from the chat.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-bridge-tg-'));
process.env.ARENA_BRIDGE_HOME = path.join(TMP, 'home');
fs.mkdirSync(process.env.ARENA_BRIDGE_HOME, { recursive: true });

const { saveConfig, DEFAULTS, CONFIG_DIR } = await import('../src/config.mjs');
const { Engine } = await import('../src/engine.mjs');
const { createDirectServer } = await import('../src/direct.mjs');
const tg = await import('../src/telegram.mjs');

const WORK = path.join(TMP, 'work');
fs.mkdirSync(WORK, { recursive: true });

/* ------------------------------------------------------------------ *
 * a fake Bot API
 * ------------------------------------------------------------------ */

const sent = [];
const queue = [];

const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const method = String(req.url).split('/').pop();
    const payload = body ? JSON.parse(body) : {};
    const reply = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (method === 'getMe') {
      return reply({ ok: true, result: { id: 1, username: 'bridge_test_bot', first_name: 'Bridge' } });
    }
    if (method === 'sendMessage') {
      sent.push(payload);
      return reply({ ok: true, result: { message_id: sent.length, chat: { id: Number(payload.chat_id) } } });
    }
    if (method === 'getUpdates') {
      return reply({ ok: true, result: queue.splice(0, queue.length) });
    }
    if (method === 'answerCallbackQuery') {
      sent.push({ method, payload });
      return reply({ ok: true, result: true });
    }
    if (method === 'editMessageText') {
      sent.push({ method, payload });
      return reply({ ok: true, result: { message_id: payload.message_id } });
    }
    return reply({ ok: false, error_code: 404, description: `unknown method ${method}` });
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${fake.address().port}`;

const cfg = {
  ...DEFAULTS,
  token: 'test-token',
  deviceToken: 'device-token',
  localToken: 'local-token',
  roots: [WORK],
  requireApproval: false,
  approvalWaitSec: 2,
  telegram: { enabled: true, botToken: 'test-bot-token', chatIds: ['42'], poll: false, baseUrl: BASE },
};
saveConfig(cfg);

const engine = new Engine(cfg, { base: WORK });

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

console.log('\n▸ telegram');

await test('the catalog carries the telegram tools', () => {
  const names = engine.catalog().map((t) => t.name);
  assert.ok(names.includes('notify_user'));
  assert.ok(names.includes('telegram_inbox'));
  assert.ok(names.includes('telegram_status'));
});

await test('notify_user sends a message to the configured chat', async () => {
  const before = sent.length;
  const r = await engine.call('notify_user', { text: 'готово, всё сделал', title: 'Отчёт' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(sent.length, before + 1);
  assert.equal(sent.at(-1).chat_id, '42');
  assert.match(sent.at(-1).text, /готово/);
  assert.match(sent.at(-1).text, /Отчёт/);
});

await test('a chat outside the allow list is refused', async () => {
  const r = await engine.call('notify_user', { text: 'привет', chat_id: '999' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'telegram_chat_not_allowed');
});

await test('an empty message is refused', async () => {
  const r = await engine.call('notify_user', { text: '   ' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'telegram_empty_message');
});

await test('a message that is too long is refused', async () => {
  const r = await engine.call('notify_user', { text: 'x'.repeat(5000) });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'telegram_message_too_long');
});

await test('telegram_inbox returns the messages the user sent', async () => {
  tg.appendInbox({ id: 11, chat_id: 42, from: 'me', text: 'да, продолжай', date: 1 });
  const r = await engine.call('telegram_inbox', {});
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
  assert.equal(r.messages[0].text, 'да, продолжай');
  const again = await engine.call('telegram_inbox', {});
  assert.equal(again.messages[0].read, true, 'the message is marked as read');
});

await test('telegram_status reports the link', async () => {
  const r = await engine.call('telegram_status', {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.chat_ids, ['42']);
  assert.equal(typeof r.unread, 'number');
});

await test('an unconfigured bridge says so instead of failing silently', async () => {
  saveConfig({ ...cfg, telegram: { enabled: false, botToken: null, chatIds: [] } });
  const r = await engine.call('notify_user', { text: 'привет' });
  saveConfig(cfg);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'telegram_not_configured');
  assert.match(r.hint, /telegram setup/);
});

await test('a chat command is parsed', () => {
  assert.deepEqual(tg.parseCommand('/approve 1234'), { cmd: 'approve', args: '1234' });
  assert.deepEqual(tg.parseCommand('/deny'), { cmd: 'deny', args: '' });
  assert.equal(tg.parseCommand('привет'), null);
});

await test('a pending approval is announced in Telegram', async () => {
  const before = sent.length;
  saveConfig({ ...cfg, requireApproval: true, approvalWaitSec: 2 });
  const r = await engine.call('bash', { command: 'echo hi' });
  saveConfig(cfg);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'APPROVAL_PENDING');
  assert.equal(sent.length, before + 1, 'the user is told about the request');
  assert.match(sent.at(-1).text, /\/approve/);
});

await test('the approval message carries the inline buttons', async () => {
  const before = sent.length;
  saveConfig({ ...cfg, requireApproval: true, approvalWaitSec: 2 });
  const r = await engine.call('bash', { command: 'echo hi' });
  saveConfig(cfg);
  assert.equal(r.ok, false);
  const message = sent.at(-1);
  const keyboard = message.reply_markup?.inline_keyboard;
  assert.ok(keyboard, 'the message has a keyboard');
  const labels = keyboard.flat().map((b) => b.text);
  assert.deepEqual(labels, ['Approve once', 'Approve for 3h', 'Deny']);
  assert.match(keyboard.flat()[0].callback_data, /^approve:/);
  assert.match(keyboard.flat()[1].callback_data, /^approve3h:/);
  assert.match(keyboard.flat()[2].callback_data, /^deny:/);
});

await test('a button press settles the request and trusts the tool for 3 hours', async () => {
  const id = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
  const dir = path.join(CONFIG_DIR, 'approvals');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      tool: 'bash',
      args: {},
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000,
      decidedAt: null,
      decidedBy: null,
    }),
  );
  queue.push({
    update_id: 9,
    callback_query: {
      id: 'cb-1',
      data: `approve3h:${id}`,
      from: { username: 'me' },
      message: { message_id: 77, chat: { id: 42 }, date: 1 },
    },
  });
  const server = createDirectServer({ ...cfg, telegram: { ...cfg.telegram, poll: true } }, engine);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  let status = null;
  for (let i = 0; i < 40 && status !== 'approved'; i++) {
    await new Promise((r) => setTimeout(r, 250));
    status = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')).status;
  }
  await new Promise((r) => server.close(r));
  assert.equal(status, 'approved', 'the button settles the request');
  const trust = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'trust.json'), 'utf8'));
  assert.deepEqual(trust.tools, ['bash'], 'the tool is trusted');
  assert.ok(trust.until > Date.now() + 2 * 3600_000, 'the window lasts about 3 hours');
  const edited = sent.filter((m) => m.method === 'editMessageText').at(-1);
  assert.match(edited.payload.text, /Approved/);
  assert.deepEqual(edited.payload.reply_markup.inline_keyboard, [], 'the buttons are gone');
});

await test('the user can approve a request from the chat', async () => {
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const dir = path.join(CONFIG_DIR, 'approvals');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      tool: 'bash',
      args: {},
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000,
      decidedAt: null,
      decidedBy: null,
    }),
  );
  queue.push({
    update_id: 5,
    message: { chat: { id: 42 }, from: { username: 'me' }, text: `/approve ${id}`, date: 1 },
  });
  const server = createDirectServer({ ...cfg, telegram: { ...cfg.telegram, poll: true } }, engine);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  let status = null;
  for (let i = 0; i < 40 && status !== 'approved'; i++) {
    await new Promise((r) => setTimeout(r, 250));
    status = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')).status;
  }
  await new Promise((r) => server.close(r));
  assert.equal(status, 'approved', 'the approval is settled from Telegram');
});

await test('the audit log masks credentials', async () => {
  const { audit, tailAudit } = await import('../src/audit.mjs');
  audit({
    tool: 'bash',
    args: { command: 'curl https://api.telegram.org/bot8605407779:AAHsu4ZpVVrkpzjKD7Em1I-U55Zcd9ndVPY/getMe' },
  });
  const last = tailAudit(1)[0];
  assert.match(last.args.command, /bot\*\*\*/);
  assert.doesNotMatch(last.args.command, /AAHsu/);
});

await test('the rate limit protects the chat from a flood', async () => {
  let limited = null;
  for (let i = 0; i < 30; i++) {
    const r = await engine.call('notify_user', { text: `спам ${i}` });
    if (!r.ok && r.error === 'telegram_rate_limited') {
      limited = r;
      break;
    }
  }
  assert.ok(limited, 'the flood is stopped');
});

fake.close();
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
