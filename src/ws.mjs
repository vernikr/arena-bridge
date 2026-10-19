import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Minimal RFC6455 WebSocket client — no dependencies.
 * Enough for the Chrome DevTools Protocol: text frames, fragmentation, ping/pong.
 */
export class WebSocketClient extends EventEmitter {
  constructor(url) {
    super();
    this.url = new URL(url);
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
    this.upgraded = false;
    this.closed = false;
    this._key = crypto.randomBytes(16).toString('base64');
    this._openResolve = null;
    this._openReject = null;
    this._pingTimer = null;
  }

  connect(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      this._openResolve = resolve;
      this._openReject = reject;
      const socket = net.connect(
        { host: this.url.hostname, port: Number(this.url.port || 80) },
        () => {
          socket.write(
            `GET ${this.url.pathname}${this.url.search} HTTP/1.1\r\n` +
              `Host: ${this.url.host}\r\n` +
              'Upgrade: websocket\r\n' +
              'Connection: Upgrade\r\n' +
              `Sec-WebSocket-Key: ${this._key}\r\n` +
              'Sec-WebSocket-Version: 13\r\n\r\n',
          );
        },
      );
      this.socket = socket;
      socket.setTimeout(timeoutMs, () => {
        socket.destroy();
        this._fail(new Error('websocket handshake timeout'));
      });
      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('error', (err) => this._fail(err));
      socket.on('close', () => {
        this.closed = true;
        this._stopPing();
        this.emit('close');
      });
    });
  }

  _fail(err) {
    if (this._openReject) {
      const r = this._openReject;
      this._openResolve = null;
      this._openReject = null;
      r(err);
    } else if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.upgraded) {
      const idx = this.buffer.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = this.buffer.subarray(0, idx).toString('latin1');
      this.buffer = this.buffer.subarray(idx + 4);
      const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head);
      const expected = crypto.createHash('sha1').update(this._key + GUID).digest('base64');
      if (!accept || accept[1] !== expected) {
        this.socket.destroy();
        this._fail(new Error('invalid websocket handshake'));
        return;
      }
      this.upgraded = true;
      // The handshake timeout must not outlive the handshake: net sockets
      // destroy themselves after `timeout` ms of inactivity, which used to
      // kill idle DevTools connections between agent actions. From here on
      // the connection is kept alive with TCP keepalive + WS pings instead.
      this.socket.setTimeout(0);
      try {
        this.socket.setKeepAlive(true);
      } catch {
        /* ignore */
      }
      this._startPing();
      if (this._openResolve) {
        const r = this._openResolve;
        this._openResolve = null;
        this._openReject = null;
        r();
      }
      this.emit('open');
    }
    this._parseFrames();
  }

  _parseFrames() {
    for (;;) {
      const buf = this.buffer;
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < offset + 2) return;
        len = buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buf.length < offset + 8) return;
        len = Number(buf.readBigUInt64BE(offset));
        offset += 8;
      }
      let maskKey = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        maskKey = buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buf.length < offset + len) return;
      const payload = Buffer.from(buf.subarray(offset, offset + len));
      if (maskKey) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
      }
      this.buffer = buf.subarray(offset + len);
      this._handleFrame(fin, opcode, payload);
    }
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === 0x8) {
      this.close();
      return;
    }
    if (opcode === 0x9) {
      this._sendFrame(0xa, payload);
      return;
    }
    if (opcode === 0xa) return;

    if (opcode === 0x0) {
      this.fragments.push(payload);
    } else {
      this.fragments = [payload];
      this.fragmentOpcode = opcode;
    }
    if (!fin) return;

    const full = Buffer.concat(this.fragments);
    this.fragments = [];
    if (this.fragmentOpcode === 0x2) this.emit('binary', full);
    else this.emit('message', full.toString('utf8'));
    this.fragmentOpcode = null;
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this.closed) return;
      try {
        this._sendFrame(0x9, Buffer.alloc(0));
      } catch {
        /* the close handler reports the failure */
      }
    }, 30000);
    this._pingTimer.unref?.();
  }

  _stopPing() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._pingTimer = null;
  }

  send(text) {
    this._sendFrame(0x1, Buffer.from(String(text), 'utf8'));
  }

  _sendFrame(opcode, payload) {
    if (!this.socket || this.closed) throw new Error('websocket is not connected');
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this._stopPing();
    try {
      this._sendFrame(0x8, Buffer.alloc(0));
    } catch {
      /* ignore */
    }
    try {
      this.socket?.destroy();
    } catch {
      /* ignore */
    }
  }
}
