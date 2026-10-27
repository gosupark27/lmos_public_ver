// Minimal RFC 6455 server for the Node dev server (text frames, ping/pong, close).
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 64 * 1024;

export function handshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') return false;
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '', '',
  ].join('\r\n'));
  return true;
}

function frame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, data]);
}

export function transport(socket, head) {
  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let fragments = [];
  let closed = false;
  const handlers = { message: () => {}, close: () => {} };
  const t = {
    send(text) { if (!closed) socket.write(frame(0x1, text)); },
    close(code = 1000, reason = '') {
      if (closed) return;
      closed = true;
      const r = Buffer.from(String(reason).slice(0, 100), 'utf8');
      const p = Buffer.alloc(2 + r.length);
      p.writeUInt16BE(code >= 1000 && code < 5000 && ![1005, 1006, 1015].includes(code) ? code : 1000, 0);
      r.copy(p, 2);
      try { socket.write(frame(0x8, p)); } catch {}
      socket.end();
      handlers.close(code, reason);
    },
    onMessage(fn) { handlers.message = fn; },
    onClose(fn) { handlers.close = fn; },
  };
  const parse = () => {
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_MESSAGE) { t.close(1009, 'too big'); return; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      buf = buf.subarray(need);
      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        if (!closed) { closed = true; try { socket.write(frame(0x8, payload.subarray(0, 2))); } catch {} socket.end(); handlers.close(code, ''); }
        return;
      }
      if (opcode === 0x9) { socket.write(frame(0xa, payload)); continue; }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x0 || opcode === 0x2) {
        fragments.push(payload);
        if (fin) {
          const msg = Buffer.concat(fragments).toString('utf8');
          fragments = [];
          handlers.message(msg);
        }
      }
    }
  };
  socket.on('data', (d) => { buf = Buffer.concat([buf, d]); parse(); });
  socket.on('close', () => { if (!closed) { closed = true; handlers.close(1006, ''); } });
  socket.on('error', () => {});
  if (buf.length) setImmediate(parse);
  return t;
}
