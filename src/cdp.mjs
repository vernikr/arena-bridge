import { EventEmitter } from 'node:events';
import { WebSocketClient } from './ws.mjs';

/**
 * Minimal Chrome DevTools Protocol client.
 * Talks to the browser-level WebSocket endpoint and uses flattened sessions.
 */
export class CDPClient extends EventEmitter {
  constructor(wsUrl) {
    super();
    this.wsUrl = wsUrl;
    this.ws = null;
    this._id = 0;
    this._pending = new Map();
  }

  async connect(timeoutMs = 10000) {
    this.ws = new WebSocketClient(this.wsUrl);
    await this.ws.connect(timeoutMs);
    this.ws.on('message', (text) => this._onMessage(text));
    this.ws.on('close', () => {
      for (const [, p] of this._pending) p.reject(new Error('devtools connection closed'));
      this._pending.clear();
      this.emit('close');
    });
    return this;
  }

  send(method, params = {}, sessionId) {
    if (!this.ws || this.ws.closed) return Promise.reject(new Error('devtools not connected'));
    const id = ++this._id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (e) {
        this._pending.delete(id);
        reject(e);
      }
    });
  }

  _onMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id !== undefined && this._pending.has(msg.id)) {
      const p = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'devtools error'));
      else p.resolve(msg.result || {});
      return;
    }
    if (msg.method) this.emit('event', msg);
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

/** Read the browser-level WebSocket URL from a CDP HTTP endpoint. */
export async function browserWsUrl(port = 9222, host = '127.0.0.1', timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${host}:${port}/json/version`, { signal: controller.signal });
    const j = await res.json();
    if (!j.webSocketDebuggerUrl) throw new Error('no webSocketDebuggerUrl in /json/version');
    return j.webSocketDebuggerUrl;
  } finally {
    clearTimeout(timer);
  }
}
