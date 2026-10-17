#!/usr/bin/env node
/**
 * Fake Chrome DevTools Protocol endpoint used by the test suite.
 * Speaks just enough CDP to exercise the browser tools without a real Chrome.
 *
 *   node test/fake-cdp.mjs --port 9222
 */
import http from 'node:http';
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 9222);

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const state = {
  targets: [
    { targetId: 'T1', type: 'page', title: 'Fake Page', url: 'https://example.com/' },
    { targetId: 'T2', type: 'page', title: 'Second Tab', url: 'https://example.org/' },
  ],
  sessions: new Map(),
  counter: 0,
};

/* ---------------- minimal websocket server ---------------- */

function attachWs(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);

  let buffer = Buffer.alloc(0);
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let len = buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < offset + 2) return;
        len = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buffer.length < offset + 8) return;
        len = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
      }
      let maskKey = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + len) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + len));
      if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
      buffer = buffer.subarray(offset + len);
      if (opcode === 0x8) {
        socket.end();
        return;
      }
      if (opcode === 0x9) {
        sendFrame(socket, 0xa, payload);
        continue;
      }
      if (opcode === 0x1 || opcode === 0x0) handleMessage(payload.toString('utf8'), socket);
    }
  };
  socket.on('data', onData);
  socket.on('error', () => {});
}

function sendFrame(socket, opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  socket.write(Buffer.concat([header, payload]));
}

function handleMessage(text, socket) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  const { id, method, params = {}, sessionId } = msg;
  let result = {};

  switch (method) {
    case 'Target.getTargets':
      result = { targetInfos: state.targets };
      break;
    case 'Target.attachToTarget': {
      const sid = `S${++state.counter}`;
      state.sessions.set(sid, params.targetId);
      result = { sessionId: sid };
      break;
    }
    case 'Target.createTarget': {
      const targetId = `T${state.targets.length + 1}`;
      state.targets.push({
        targetId,
        type: 'page',
        title: 'New Tab',
        url: params.url || 'about:blank',
      });
      result = { targetId };
      break;
    }
    case 'Target.closeTarget':
      state.targets = state.targets.filter((t) => t.targetId !== params.targetId);
      result = { success: true };
      break;
    case 'Page.navigate':
      result = { frameId: 'FRAME1', loaderId: 'LOADER1' };
      break;
    case 'Page.captureScreenshot':
      result = { data: TINY_PNG };
      break;
    case 'Page.getLayoutMetrics':
      result = { cssContentSize: { width: 1280, height: 800 } };
      break;
    case 'Accessibility.getFullAXTree':
      result = {
        nodes: [
          { role: { value: 'button' }, name: { value: 'Submit' } },
          { role: { value: 'link' }, name: { value: 'Home' } },
          { role: { value: 'none' }, name: { value: '' } },
        ],
      };
      break;
    case 'Fake.large':
      result = { data: 'y'.repeat(300000) };
      break;
    case 'Runtime.evaluate': {
      const expr = String(params.expression || '');
      if (expr.includes('outerHTML')) result = { result: { value: '<html><body>fake</body></html>' } };
      else if (expr.includes('document.title'))
        result = {
          result: {
            value: { title: 'Fake Page', url: 'https://example.com/', text: 'Hello from the fake page' },
          },
        };
      else if (expr.includes('clicked')) result = { result: { value: { clicked: true, tag: 'BUTTON', text: 'Submit' } } };
      else if (expr.includes('focus()')) result = { result: { value: { ok: true, value: 'typed' } } };
      else result = { result: { value: 'evaluated' } };
      break;
    }
    default:
      result = {};
  }

  const payload = Buffer.from(JSON.stringify({ id, result, sessionId }), 'utf8');
  sendFrame(socket, 0x1, payload);
}

/* ---------------- http endpoints ---------------- */

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/json/version')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        Browser: 'FakeChrome/1.0',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake`,
      }),
    );
    return;
  }
  if (req.url.startsWith('/json/list')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(state.targets));
    return;
  }
  res.writeHead(404);
  res.end('{}');
});

server.on('upgrade', attachWs);
server.listen(port, '127.0.0.1', () => {
  console.log(`fake-cdp listening on 127.0.0.1:${port}`);
});
