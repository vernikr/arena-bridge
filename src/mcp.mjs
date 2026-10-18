/**
 * Minimal MCP (Model Context Protocol) over Streamable HTTP.
 * Supports the subset needed for tool discovery and invocation: initialize,
 * tools/list, tools/call, ping, notifications/initialized.
 */
import { readJson, sendJson } from './http.mjs';

const PROTOCOL_VERSION = '2025-06-18';

export function mcpResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

export function mcpError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export async function handleMcp(req, res, ctx) {
  let body;
  try {
    body = await readJson(req, ctx.cfg?.maxUploadBytes || 16 * 1024 * 1024);
  } catch (e) {
    sendJson(res, 400, mcpError(null, -32700, e.message));
    return;
  }

  const messages = Array.isArray(body) ? body : [body];
  const responses = [];

  for (const msg of messages) {
    if (!msg || msg.jsonrpc !== '2.0') {
      responses.push(mcpError(null, -32600, 'invalid JSON-RPC message'));
      continue;
    }
    const { method, id, params } = msg;

    // notifications carry no id and expect no response
    if (id === undefined || id === null) {
      if (method === 'notifications/initialized' || method?.startsWith('notifications/')) {
        continue;
      }
      continue;
    }

    switch (method) {
      case 'initialize':
        responses.push(
          mcpResponse(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'arena-bridge', version: '0.6.10' },
            instructions:
              'Tools operate the user\'s own machine. Dangerous operations may return ' +
              'PROTECTED and require a local human approval.',
          }),
        );
        break;
      case 'ping':
        responses.push(mcpResponse(id, {}));
        break;
      case 'tools/list':
        responses.push(mcpResponse(id, { tools: ctx.listTools() }));
        break;
      case 'tools/call': {
        const name = params?.name;
        const args = params?.arguments || {};
        if (!name) {
          responses.push(mcpError(id, -32602, 'tool name is required'));
          break;
        }
        const result = await ctx.callTool(name, args);
        const text = result?.ok
          ? JSON.stringify(result, null, 2)
          : `ERROR ${result?.error || 'unknown'}\n${result?.reason || ''}\n${JSON.stringify(result, null, 2)}`;
        responses.push(
          mcpResponse(id, {
            content: [{ type: 'text', text }],
            isError: !result?.ok,
          }),
        );
        break;
      }
      default:
        responses.push(mcpError(id, -32601, `method not found: ${method}`));
    }
  }

  if (!responses.length) {
    res.writeHead(202).end();
    return;
  }
  sendJson(res, 200, responses.length === 1 ? responses[0] : responses);
}
