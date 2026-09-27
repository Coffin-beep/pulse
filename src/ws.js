'use strict';

// Минимальная реализация WebSocket (RFC 6455) для серверной части без зависимостей.
// Поддерживает текстовые и бинарные фреймы, ping/pong, close. Фрагментация не поддерживается
// (наши сообщения всегда меньше 64 КБ).

const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptValue(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

class WSConn {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.alive = true;
    this.onmessage = null; // (opcode, payload: Buffer)
    this.onclose = null;

    socket.on('data', (d) => this._onData(d));
    socket.on('error', () => this._destroy());
    socket.on('close', () => this._destroy());
    // клиент может полузакрыть соединение (FIN): для нас это тоже конец
    socket.on('end', () => this._destroy());
  }

  _onData(d) {
    if (!this.alive) return;
    this.buffer = Buffer.concat([this.buffer, d]);
    let frame;
    while ((frame = this._parseFrame()) !== null) {
      const { opcode, payload } = frame;
      if (opcode === 0x8) { // close
        this.close(1000);
        return;
      }
      if (opcode === 0x9) { // ping -> pong
        this._sendFrame(0xA, payload);
        continue;
      }
      if (opcode === 0xA) continue; // pong
      if (this.onmessage) this.onmessage(opcode, payload);
    }
  }

  _parseFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;

    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      len = Number(buf.readBigUInt64BE(2));
      off = 10;
    }
    if (len > 1024 * 1024) { // защита от гигантских фреймов
      this.close(1009);
      return null;
    }

    let maskKey = null;
    if (masked) {
      if (buf.length < off + 4) return null;
      maskKey = buf.subarray(off, off + 4);
      off += 4;
    }
    if (buf.length < off + len) return null;

    let payload = buf.subarray(off, off + len);
    if (maskKey) {
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
      payload = out;
    }
    this.buffer = buf.subarray(off + len);
    if (!fin) return { opcode: 0, payload: Buffer.alloc(0) }; // продолжения игнорируем
    return { opcode, payload };
  }

  _sendFrame(opcode, payload) {
    if (!this.alive) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (_) {
      this._destroy();
    }
  }

  sendText(str) {
    this._sendFrame(0x1, Buffer.from(str, 'utf8'));
  }

  sendBinary(buf) {
    this._sendFrame(0x2, buf);
  }

  close(code = 1000) {
    if (!this.alive) return;
    const b = Buffer.allocUnsafe(2);
    b.writeUInt16BE(code, 0);
    this._sendFrame(0x8, b);
    this._destroy();
  }

  _destroy() {
    if (!this.alive) return;
    this.alive = false;
    try { this.socket.destroy(); } catch (_) { /* noop */ }
    if (this.onclose) {
      const cb = this.onclose;
      this.onclose = null;
      cb();
    }
  }
}

// HTTP Upgrade -> WebSocket. Возвращает WSConn или null (и рвёт сокет).
function acceptUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers['upgrade'] || '').toLowerCase();
  if (!key || upgrade !== 'websocket') {
    try {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } catch (_) { /* noop */ }
    socket.destroy();
    return null;
  }
  try {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + acceptValue(key) + '\r\n\r\n'
    );
  } catch (_) {
    socket.destroy();
    return null;
  }
  socket.setNoDelay(true);
  return new WSConn(socket);
}

module.exports = { acceptUpgrade, WSConn };
