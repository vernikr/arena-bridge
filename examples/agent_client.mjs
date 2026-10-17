#!/usr/bin/env node
/**
 * Tiny client for the cloud agent side. Copy this file into the agent's sandbox.
 *
 *   export ARENA_BRIDGE_URL="https://xxx.trycloudflare.com"
 *   export ARENA_BRIDGE_TOKEN="<token>"
 *
 *   node agent_client.mjs devices
 *   node agent_client.mjs call bash '{"command":"uname -a"}'
 *   node agent_client.mjs exec "ls -la ~/projects"
 */
const URL = (process.env.ARENA_BRIDGE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const TOKEN = process.env.ARENA_BRIDGE_TOKEN || '';

async function call(path, method = 'GET', body) {
  const headers = { Authorization: `Bearer ${TOKEN}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: text };
  }
}

const [, , cmd, ...rest] = process.argv;

switch (cmd) {
  case 'devices':
    console.log(JSON.stringify(await call('/devices'), null, 2));
    break;
  case 'tools':
    console.log(JSON.stringify(await call('/tools'), null, 2));
    break;
  case 'prompt': {
    const res = await fetch(`${URL}/prompt`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    console.log(await res.text());
    break;
  }
  case 'call': {
    const [tool, argsJson] = rest;
    const result = await call('/call', 'POST', { tool, args: argsJson ? JSON.parse(argsJson) : {} });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\nIf this is a PROTECTED error, ask the user to run ` +
          `\`arena-bridge approve ${result.approval_id}\` on their machine, then retry once.`,
      );
    }
    process.exit(result.ok ? 0 : 2);
    break;
  }
  case 'exec': {
    const result = await call('/exec', 'POST', { command: rest.join(' ') });
    process.stdout.write(result.stdout || '');
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.ok ? 0 : 2);
    break;
  }
  default:
    console.log('usage: agent_client.mjs <devices|tools|prompt|call|exec>');
    process.exit(1);
}
