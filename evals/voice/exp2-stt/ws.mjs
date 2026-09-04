import { randomBytes, createHash } from "node:crypto";
import https from "node:https";
import http from "node:http";

function maskXor(payload, mask) {
  const out = Buffer.from(payload);
  for (let i = 0; i < out.length; i++) out[i] ^= mask[i & 3];
  return out;
}

function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = randomBytes(4);
  const masked = maskXor(data, mask);
  let header;
  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | data.length;
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, mask, masked]);
}

function decodeOne(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WS frame too large");
    len = Number(big);
    offset = 10;
  }
  let mask;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  let payload = buf.subarray(offset, offset + len);
  if (mask) payload = maskXor(payload, mask);
  return { fin, opcode, payload, rest: buf.subarray(offset + len) };
}

export class HeaderWebSocket {
  constructor(url, { headers = {} } = {}) {
    this.url = new URL(url);
    this.headers = headers;
    this.listeners = { open: [], message: [], close: [], error: [] };
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.readyState = 0;
  }

  addEventListener(type, fn) {
    (this.listeners[type] || (this.listeners[type] = [])).push(fn);
  }

  emit(type, event) {
    for (const fn of this.listeners[type] || []) fn(event);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString("base64");
      const isTls = this.url.protocol === "wss:";
      const port = Number(this.url.port) || (isTls ? 443 : 80);
      const path = `${this.url.pathname}${this.url.search}`;
      const reqHeaders = {
        Host: this.url.host,
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
        ...this.headers,
      };
      const req = (isTls ? https : http).request({
        hostname: this.url.hostname,
        port,
        path,
        method: "GET",
        headers: reqHeaders,
        timeout: 12_000,
      });
      req.setTimeout(12_000, () => {
        req.destroy();
        const err = new Error("WebSocket connect timeout");
        err.code = "ETIMEDOUT";
        reject(err);
      });
      req.on("upgrade", (res, socket) => {
        const expected = createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
          .digest("base64");
        if (res.headers["sec-websocket-accept"] !== expected) {
          socket.destroy();
          const err = new Error("WebSocket accept mismatch");
          err.code = "ECONNRESET";
          reject(err);
          return;
        }
        this.socket = socket;
        this.readyState = 1;
        socket.on("data", (chunk) => this.#onData(chunk));
        socket.on("error", (err) => {
          this.readyState = 3;
          this.emit("error", err);
        });
        socket.on("close", () => {
          const wasOpen = this.readyState === 1;
          this.readyState = 3;
          this.emit("close", { code: wasOpen ? 1006 : 1006, reason: "", wasClean: false });
        });
        this.emit("open", {});
        resolve(this);
      });
      req.on("response", (res) => {
        const err = new Error(`WebSocket HTTP ${res.statusCode}`);
        err.status = res.statusCode;
        err.code = `HTTP_${res.statusCode}`;
        reject(err);
        res.resume();
      });
      req.on("error", (err) => {
        err.code = err.code || "ECONNRESET";
        reject(err);
      });
      req.end();
    });
  }

  send(data) {
    if (!this.socket || this.readyState !== 1) throw new Error("WebSocket not open");
    this.socket.write(encodeFrame(0x1, data));
  }

  close() {
    if (!this.socket || this.readyState !== 1) return;
    try {
      this.socket.write(encodeFrame(0x8, Buffer.alloc(0)));
    } catch {
      // ignore
    }
    this.readyState = 2;
    this.socket.end();
  }

  #onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      let frame;
      try {
        frame = decodeOne(this.buf);
      } catch (err) {
        this.emit("error", err);
        return;
      }
      if (!frame) break;
      this.buf = frame.rest;
      if (frame.opcode === 0x8) {
        this.readyState = 3;
        this.emit("close", { code: 1000, reason: "", wasClean: true });
        this.socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        this.socket.write(encodeFrame(0xa, frame.payload));
        continue;
      }
      if (frame.opcode === 0xa) continue;
      if (frame.opcode === 0x0 || frame.opcode === 0x1 || frame.opcode === 0x2) {
        if (frame.opcode !== 0x0) {
          this.fragments = [frame.payload];
          this.fragmentOpcode = frame.opcode;
        } else {
          this.fragments.push(frame.payload);
        }
        if (frame.fin) {
          const payload = Buffer.concat(this.fragments);
          this.fragments = [];
          const data = this.fragmentOpcode === 0x1 ? payload.toString("utf8") : payload;
          this.emit("message", { data });
        }
      }
    }
  }
}

export async function openHeaderWebSocket(url, headers) {
  const ws = new HeaderWebSocket(url, { headers });
  await ws.connect();
  return ws;
}
