#!/usr/bin/env node
/**
 * Probe: can subscription xAI OAuth open Grok Voice S2S realtime?
 * Secrets stay in memory / temp curl config (unlinked). Never printed.
 *
 *   node evals/voice/exp6-grok-voice/probe.mjs
 *
 * This machine's Node https to api.x.ai times out (no proxy). curl uses
 * HTTPS_PROXY 127.0.0.1:7897. HTTP goes through curl -4; remote WS uses
 * HTTP CONNECT via that proxy then TLS. Loopback 8317 is direct.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { setDefaultResultOrder } from "node:dns";

setDefaultResultOrder("ipv4first");

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const AUTH_DIR = join(homedir(), ".cli-proxy-api", "auths");
const CLI_PROXY_CONFIG = join(homedir(), ".cli-proxy-api", "config.yaml");
const RESULTS_MD = join(ROOT, "evals/voice/results/2026-09-04-mouth-candidates.md");
const WORK = join(ROOT, ".work/voice-experiments/exp6");
const XAI_API = "https://api.x.ai/v1";
const WS_PATH = "/v1/realtime?model=grok-voice-latest";
const XAI_WS = `wss://api.x.ai${WS_PATH}`;
const LOCAL_WS = `ws://127.0.0.1:8317${WS_PATH}`;
const MODEL_ID_RE = /voice|realtime|tts|stt/i;
const WS_WAIT_MS = 8_000;
const HTTP_TIMEOUT_MS = 20_000;
const FORBIDDEN =
  /Bearer |access_token|refresh_token|Authorization:|\beyJ[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/i;

function redact(value) {
  return String(value ?? "")
    .replace(/Bearer\s+\S+/gi, "[auth]")
    .replace(/access_token/gi, "oauth-access")
    .replace(/refresh_token/gi, "oauth-refresh")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt]")
    .replace(/[A-Za-z0-9+/_-]{40,}/g, "[long-token]")
    .replace(/Authorization:\s*\S+/gi, "[auth]");
}

function truncate(value, n = 120) {
  const s = redact(String(value ?? "")).replace(/\s+/g, " ").trim();
  if (s.length <= n) return s;
  return s.slice(0, n);
}

function assertSafe(label, text) {
  const s = String(text ?? "");
  if (FORBIDDEN.test(s)) {
    throw new Error(`refusing to write ${label}: would leak a secret-shaped string`);
  }
}

function loadCliProxyApiKeys(configPath) {
  const tried = { exists: existsSync(configPath), field: "api-keys", count: 0, lengths: [] };
  if (!tried.exists) return { keys: [], tried };
  const lines = readFileSync(configPath, "utf8").split("\n");
  const keys = [];
  let inKeys = false;
  let indent = 0;
  for (const line of lines) {
    if (!inKeys) {
      if (/^api-keys\s*:/.test(line)) {
        inKeys = true;
        indent = line.match(/^\s*/)[0].length;
        const inline = line.replace(/^api-keys\s*:\s*/, "").trim();
        if (inline && inline !== "|" && inline !== ">") {
          keys.push(inline.replace(/^["']|["']$/g, ""));
        }
      }
      continue;
    }
    const i = (line.match(/^\s*/) || [""])[0].length;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (i <= indent && /[A-Za-z]/.test(line[i] || "")) break;
    if (trimmed.startsWith("-")) {
      const val = trimmed.slice(1).trim();
      const mapped = val.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
      if (mapped && /key|token|secret/i.test(mapped[1])) {
        const v = mapped[2].replace(/^["']|["']$/g, "");
        if (v) keys.push(v);
      } else {
        const v = val.replace(/^["']|["']$/g, "");
        if (v) keys.push(v);
      }
    }
  }
  tried.count = keys.length;
  tried.lengths = keys.map((k) => k.length);
  return { keys, tried };
}

function findGmailXaiPath(dir) {
  if (!existsSync(dir)) throw new Error("auths dir missing");
  const names = readdirSync(dir).filter((n) => n.startsWith("xai-") && n.endsWith(".json"));
  const gmail = names.find((n) => /gmail/i.test(n));
  if (!gmail) throw new Error("no gmail xAI json");
  return join(dir, gmail);
}

function jwtPayload(token) {
  try {
    const mid = String(token).split(".")[1];
    if (!mid) return null;
    return JSON.parse(Buffer.from(mid, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function parseProxy() {
  const raw =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;
  if (!raw) return null;
  try {
    const u = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`);
    const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
    return { hostname: u.hostname, port, label: `${u.hostname}:${port}` };
  } catch {
    return null;
  }
}

function isLoopback(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function parseExpired(raw) {
  if (typeof raw !== "string" || !raw) return { present: false, inPast: null, iso: null };
  const ms = Date.parse(raw);
  return {
    present: true,
    inPast: Number.isFinite(ms) ? ms < Date.now() : null,
    iso: Number.isFinite(ms) ? new Date(ms).toISOString() : null,
  };
}

function pickError(json) {
  if (!json || typeof json !== "object") return { code: null, error: null };
  const err = json.error;
  if (typeof err === "string") {
    return { code: json.code ?? json.type ?? null, error: truncate(err) };
  }
  if (err && typeof err === "object") {
    return {
      code: err.code ?? err.type ?? json.code ?? null,
      error: truncate(err.message ?? err.error ?? JSON.stringify(err)),
    };
  }
  if (typeof json.message === "string") {
    return { code: json.code ?? json.type ?? null, error: truncate(json.message) };
  }
  return { code: json.code ?? json.type ?? null, error: null };
}

function parseMaybeJson(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf ?? "");
  if (!text.trim()) return { json: null, text: "" };
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

function curlIPv4({ method, url, token, body, timeoutMs = HTTP_TIMEOUT_MS, binary = false }) {
  const started = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "yishu-exp6-"));
  const conf = join(dir, "curl.conf");
  const bodyPath = join(dir, "body.json");
  const outPath = join(dir, "out.bin");
  try {
    const lines = [
      "silent",
      "show-error",
      "ipv4",
      `max-time = ${Math.ceil(timeoutMs / 1000)}`,
      `request = ${method}`,
      `header = "Accept: ${binary ? "*/*" : "application/json"}"`,
      `header = "Authorization: Bearer ${token}"`,
      `output = ${JSON.stringify(outPath)}`,
      `write-out = "%{http_code}"`,
      `url = ${JSON.stringify(url)}`,
    ];
    if (body != null) {
      writeFileSync(bodyPath, typeof body === "string" ? body : JSON.stringify(body));
      lines.push(`header = "Content-Type: application/json"`);
      lines.push(`data-binary = ${JSON.stringify(`@${bodyPath}`)}`);
    }
    writeFileSync(conf, `${lines.join("\n")}\n`, { mode: 0o600 });
    const statusText = execFileSync("curl", ["-4", "-K", conf], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const status = Number(statusText) || 0;
    const raw = existsSync(outPath) ? readFileSync(outPath) : Buffer.alloc(0);
    const row = {
      status,
      ms: Date.now() - started,
      bytes: raw.length,
      transport: "curl-4",
    };
    if (binary) {
      row.body = raw;
      if (status !== 200) {
        const parsed = parseMaybeJson(raw);
        row.json = parsed.json;
        if (parsed.json) {
          const bits = pickError(parsed.json);
          row.code = bits.code;
          row.error = bits.error;
        } else if (parsed.text) {
          row.error = truncate(parsed.text);
        }
      }
      return row;
    }
    const parsed = parseMaybeJson(raw);
    row.json = parsed.json;
    if (parsed.json) {
      const bits = pickError(parsed.json);
      row.code = bits.code;
      row.error = bits.error;
    } else if (parsed.text) {
      row.error = truncate(parsed.text);
    }
    return row;
  } catch (err) {
    return {
      status: 0,
      network: err.code || "curl_error",
      error: truncate(err.stderr ? String(err.stderr) : err.message),
      ms: Date.now() - started,
      transport: "curl-4",
    };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

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
  return { opcode, payload, rest: buf.subarray(offset + len) };
}

function parseClose(payload) {
  if (!payload || payload.length < 2) return { code: null, reason: "" };
  return { code: payload.readUInt16BE(0), reason: truncate(payload.subarray(2).toString("utf8"), 80) };
}

function connectHttpProxy(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: proxy.hostname, port: proxy.port, family: 4 }, () => {
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    const timer = setTimeout(() => {
      sock.destroy();
      const err = new Error("proxy CONNECT timeout");
      err.code = "timeout";
      reject(err);
    }, timeoutMs);
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx < 0) return;
      clearTimeout(timer);
      const head = buf.subarray(0, idx).toString("utf8");
      const rest = buf.subarray(idx + 4);
      const m = head.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/);
      const status = m ? Number(m[1]) : 0;
      if (status !== 200) {
        sock.destroy();
        const err = new Error(`proxy CONNECT ${status}`);
        err.code = `CONNECT_${status}`;
        reject(err);
        return;
      }
      sock.removeAllListeners("data");
      if (rest.length) sock.unshift(rest);
      resolve(sock);
    });
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function tlsWrap(socket, servername, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      const err = new Error("tls timeout");
      err.code = "timeout";
      reject(err);
    }, timeoutMs);
    const tlsSock = tls.connect({ socket, servername, minVersion: "TLSv1.2" }, () => {
      clearTimeout(timer);
      resolve(tlsSock);
    });
    tlsSock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function openTcp({ url, proxy, timeoutMs }) {
  const isTls = url.protocol === "wss:" || url.protocol === "https:";
  const port = Number(url.port) || (isTls ? 443 : 80);
  const host = url.hostname;
  if (isLoopback(host) || !proxy) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host, port, family: 4 }, () => resolve({ sock, isTls: false, alreadyTls: false }));
      sock.setTimeout(timeoutMs, () => {
        sock.destroy();
        const err = new Error("tcp timeout");
        err.code = "timeout";
        reject(err);
      });
      sock.on("error", reject);
    }).then(async ({ sock }) => {
      sock.setTimeout(0);
      if (!isTls) return sock;
      return tlsWrap(sock, host, timeoutMs);
    });
  }
  return connectHttpProxy(proxy, host, port, timeoutMs).then((raw) => {
    if (!isTls) return raw;
    return tlsWrap(raw, host, timeoutMs);
  });
}

function readHttpResponse(sock) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx < 0) return;
      sock.removeListener("data", onData);
      sock.removeListener("error", onErr);
      const head = buf.subarray(0, idx).toString("utf8");
      const rest = buf.subarray(idx + 4);
      const first = head.split("\r\n")[0] || "";
      const m = first.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/);
      const status = m ? Number(m[1]) : 0;
      const headers = {};
      for (const line of head.split("\r\n").slice(1)) {
        const c = line.indexOf(":");
        if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
      }
      resolve({ status, headers, rest, head });
    };
    const onErr = (err) => reject(err);
    sock.on("data", onData);
    sock.on("error", onErr);
  });
}

function probeWebSocket({ url, token, waitMs = WS_WAIT_MS, proxy = null }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const u = new URL(url);
    const key = randomBytes(16).toString("base64");
    let settled = false;
    let socket = null;
    const finish = (row) => {
      if (settled) return;
      settled = true;
      try {
        if (socket) socket.destroy();
      } catch {
        /* ignore */
      }
      resolve({
        ...row,
        ms: Date.now() - started,
        transport: isLoopback(u.hostname) ? "node-ws-loopback" : "node-ws-proxy-connect",
      });
    };
    const timer = setTimeout(() => {
      finish({ upgraded: false, status: 0, network: "timeout" });
    }, waitMs + 4_000);

    openTcp({ url: u, proxy: isLoopback(u.hostname) ? null : proxy, timeoutMs: waitMs })
      .then(async (sock) => {
        socket = sock;
        const path = `${u.pathname}${u.search}`;
        const req = [
          `GET ${path} HTTP/1.1`,
          `Host: ${u.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          `Authorization: Bearer ${token}`,
          "",
          "",
        ].join("\r\n");
        sock.write(req);
        const httpRes = await readHttpResponse(sock);
        if (httpRes.status !== 101) {
          let body = httpRes.rest;
          if (body.length < 4096) {
            await new Promise((r) => {
              const t = setTimeout(r, 400);
              sock.once("data", (c) => {
                clearTimeout(t);
                body = Buffer.concat([body, c]);
                r();
              });
            });
          }
          const parsed = parseMaybeJson(body);
          const bits = parsed.json ? pickError(parsed.json) : { code: null, error: truncate(parsed.text || httpRes.head.split("\r\n")[0]) };
          clearTimeout(timer);
          finish({
            upgraded: false,
            status: httpRes.status,
            code: bits.code,
            error: bits.error,
          });
          return;
        }
        const expected = createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
          .digest("base64");
        if (httpRes.headers["sec-websocket-accept"] !== expected) {
          clearTimeout(timer);
          finish({ upgraded: false, status: 101, error: "accept_mismatch" });
          return;
        }
        let buf = httpRes.rest;
        const eventTimer = setTimeout(() => {
          try {
            sock.write(encodeFrame(0x8, Buffer.alloc(0)));
          } catch {
            /* ignore */
          }
          clearTimeout(timer);
          finish({
            upgraded: true,
            status: 101,
            firstEventType: null,
            closeReason: "no event within 8s",
          });
        }, waitMs);
        const consume = (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          while (true) {
            let frame;
            try {
              frame = decodeOne(buf);
            } catch (err) {
              clearTimeout(eventTimer);
              clearTimeout(timer);
              finish({ upgraded: true, status: 101, error: truncate(err.message) });
              return;
            }
            if (!frame) break;
            buf = frame.rest;
            if (frame.opcode === 0x8) {
              clearTimeout(eventTimer);
              clearTimeout(timer);
              const close = parseClose(frame.payload);
              finish({
                upgraded: true,
                status: 101,
                firstEventType: null,
                closeCode: close.code,
                closeReason: close.reason || "closed before event",
              });
              return;
            }
            if (frame.opcode === 0x9) {
              try {
                sock.write(encodeFrame(0xa, frame.payload));
              } catch {
                /* ignore */
              }
              continue;
            }
            if (frame.opcode === 0xa) continue;
            if (frame.opcode === 0x1 || frame.opcode === 0x2) {
              const text = frame.payload.toString("utf8");
              let type = null;
              try {
                const json = JSON.parse(text);
                type = typeof json.type === "string" ? json.type : null;
                if (!type && json.error) type = "error";
              } catch {
                type = "_non_json";
              }
              clearTimeout(eventTimer);
              clearTimeout(timer);
              try {
                sock.write(encodeFrame(0x8, Buffer.alloc(0)));
              } catch {
                /* ignore */
              }
              finish({ upgraded: true, status: 101, firstEventType: type });
              return;
            }
          }
        };
        if (buf.length) consume(Buffer.alloc(0));
        sock.on("data", consume);
        sock.on("error", (err) => {
          clearTimeout(eventTimer);
          clearTimeout(timer);
          finish({
            upgraded: true,
            status: 101,
            network: err.code || "socket_error",
            error: truncate(err.message),
          });
        });
        sock.on("close", () => {
          clearTimeout(eventTimer);
          clearTimeout(timer);
          if (!settled) finish({ upgraded: true, status: 101, closeReason: "socket closed, no event" });
        });
      })
      .catch((err) => {
        clearTimeout(timer);
        finish({
          upgraded: false,
          status: 0,
          network: err.code || "error",
          error: truncate(err.message),
        });
      });
  });
}

function listenSnapshot() {
  try {
    return execFileSync("lsof", ["-nP", "-iTCP:8317", "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "(not listening)";
  }
}

function voiceLikeIds(json) {
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  return rows
    .map((row) => (typeof row === "string" ? row : row?.id))
    .filter((id) => typeof id === "string" && MODEL_ID_RE.test(id));
}

function voiceCount(json) {
  if (!json || typeof json !== "object") return 0;
  if (Array.isArray(json.voices)) return json.voices.length;
  if (Array.isArray(json.data)) return json.data.length;
  if (Array.isArray(json)) return json.length;
  return 0;
}

function secretIssued(json) {
  if (!json || typeof json !== "object") return { issued: false, valueLen: 0, expiresAtPresent: false };
  const nested = json.client_secret && typeof json.client_secret === "object" ? json.client_secret : json;
  const value = nested.value;
  return {
    issued: typeof value === "string" && value.length > 0,
    valueLen: typeof value === "string" ? value.length : 0,
    expiresAtPresent: nested.expires_at != null || json.expires_at != null,
  };
}

function curlForm({ url, form, timeoutMs = HTTP_TIMEOUT_MS }) {
  const started = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "yishu-exp6-"));
  const conf = join(dir, "curl.conf");
  const bodyPath = join(dir, "body.txt");
  const outPath = join(dir, "out.bin");
  try {
    writeFileSync(bodyPath, form);
    writeFileSync(
      conf,
      [
        "silent",
        "show-error",
        "ipv4",
        `max-time = ${Math.ceil(timeoutMs / 1000)}`,
        "request = POST",
        `header = "Accept: application/json"`,
        `header = "Content-Type: application/x-www-form-urlencoded"`,
        `data-binary = ${JSON.stringify(`@${bodyPath}`)}`,
        `output = ${JSON.stringify(outPath)}`,
        `write-out = "%{http_code}"`,
        `url = ${JSON.stringify(url)}`,
      ].join("\n") + "\n",
      { mode: 0o600 },
    );
    const statusText = execFileSync("curl", ["-4", "-K", conf], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const raw = existsSync(outPath) ? readFileSync(outPath) : Buffer.alloc(0);
    const parsed = parseMaybeJson(raw);
    return {
      status: Number(statusText) || 0,
      json: parsed.json,
      error: parsed.json ? pickError(parsed.json).error : truncate(parsed.text),
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      status: 0,
      network: err.code || "curl_error",
      error: truncate(err.stderr ? String(err.stderr) : err.message),
      ms: Date.now() - started,
    };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function refreshIfNeeded(auth) {
  const expired = parseExpired(auth.expired);
  if (expired.inPast !== true) {
    return { refreshed: false, reason: "not_expired", token: auth.access_token, expired };
  }
  const endpoint = auth.token_endpoint;
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) {
    return { refreshed: false, reason: "no_token_endpoint", token: auth.access_token, expired };
  }
  const payload = jwtPayload(auth.access_token) || {};
  const clientId = payload.client_id || payload.aud;
  if (typeof clientId !== "string" || !clientId) {
    return { refreshed: false, reason: "no_client_id", token: auth.access_token, expired };
  }
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: auth.refresh_token,
    client_id: clientId,
  }).toString();
  const row = curlForm({ url: endpoint, form });
  const newToken = row.json?.access_token;
  if (row.status === 200 && typeof newToken === "string" && newToken.length > 20) {
    return {
      refreshed: true,
      reason: "ok",
      token: newToken,
      expired,
      status: row.status,
      ms: row.ms,
      newAccessLen: newToken.length,
    };
  }
  return {
    refreshed: false,
    reason: "refresh_failed",
    token: auth.access_token,
    expired,
    status: row.status,
    error: row.error,
    network: row.network,
  };
}

function verdictOf({ xaiWs, tts, clientSecrets, localWs, models, voices }) {
  const netFail = (row) =>
    row &&
    row.status === 0 &&
    !row.upgraded &&
    /SSL|EPROTO|CERT|UNABLE_TO_VERIFY|ECONNRESET|ENOTFOUND|timeout|curl_error|CONNECT_/i.test(
      `${row.network || ""} ${row.error || ""}`,
    );
  if (xaiWs.upgraded && xaiWs.firstEventType === "session.created") {
    return "S2S works with subscription OAuth (session.created received)";
  }
  const denied =
    xaiWs.status === 401 ||
    xaiWs.status === 403 ||
    clientSecrets.status === 401 ||
    clientSecrets.status === 403;
  if (denied && !xaiWs.upgraded) {
    return "TTS/STT only; S2S denied (403/401) — Grok Voice the product is console-API-key or consumer-app, not this OAuth";
  }
  if (xaiWs.upgraded && localWs && localWs.upgraded !== true) {
    return "S2S endpoint exists but 8317 cannot carry it; would need Swift to talk to api.x.ai directly with OAuth refresh";
  }
  if (netFail(xaiWs) && (netFail(models) || models.status === 0) && (netFail(voices) || voices.status === 0)) {
    return "Network/SSL failed, inconclusive";
  }
  if (xaiWs.status === 0 && !xaiWs.upgraded) return "Network/SSL failed, inconclusive";
  if (xaiWs.upgraded) {
    return "S2S endpoint exists but 8317 cannot carry it; would need Swift to talk to api.x.ai directly with OAuth refresh";
  }
  if (denied) {
    return "TTS/STT only; S2S denied (403/401) — Grok Voice the product is console-API-key or consumer-app, not this OAuth";
  }
  void tts;
  return "Network/SSL failed, inconclusive";
}

function upsertGrokSection(mdPath, body) {
  const heading = "## Grok Voice";
  const section = `${heading}\n\n${body.trim()}\n`;
  assertSafe("grok-voice section", section);
  mkdirSync(dirname(mdPath), { recursive: true });
  if (!existsSync(mdPath)) {
    writeFileSync(mdPath, section);
    return;
  }
  const existing = readFileSync(mdPath, "utf8");
  const parts = existing.split(/(?=^## )/m).filter((p) => p.trim());
  const rest = parts.filter((p) => !/^## Grok Voice\b/.test(p));
  writeFileSync(mdPath, [section.trim(), ...rest.map((p) => p.trim())].join("\n\n") + "\n");
}

function scopeFlags(token) {
  const payload = jwtPayload(token) || {};
  const scope = typeof payload.scope === "string" ? payload.scope : "";
  return {
    hasApiAccess: /\bapi:access\b/.test(scope),
    hasGrokCli: /\bgrok-cli:access\b/.test(scope),
  };
}

async function main() {
  mkdirSync(WORK, { recursive: true });
  const proxy = parseProxy();
  const authPath = findGmailXaiPath(AUTH_DIR);
  const auth = JSON.parse(readFileSync(authPath, "utf8"));
  if (auth.type !== "xai") throw new Error("preferred json is not type=xai");
  if (typeof auth.access_token !== "string" || auth.access_token.length < 20) {
    throw new Error("oauth access missing");
  }
  const refresh = refreshIfNeeded(auth);
  const token = refresh.token;
  const scopes = scopeFlags(token);
  const proxyKeys = loadCliProxyApiKeys(CLI_PROXY_CONFIG);
  const listen = listenSnapshot();

  const models = curlIPv4({ method: "GET", url: `${XAI_API}/models`, token });
  const voiceIds = models.json ? voiceLikeIds(models.json) : [];
  const voices = curlIPv4({ method: "GET", url: `${XAI_API}/tts/voices`, token });
  const clientSecrets = curlIPv4({
    method: "POST",
    url: `${XAI_API}/realtime/client_secrets`,
    token,
    body: { expires_after: { seconds: 300 } },
  });
  const secretMeta = clientSecrets.status === 200 ? secretIssued(clientSecrets.json) : { issued: false, valueLen: 0 };
  if (secretMeta.issued) delete clientSecrets.json;

  const xaiWs = await probeWebSocket({ url: XAI_WS, token, proxy });
  const localKey = proxyKeys.keys[0] || "";
  const localWs = localKey
    ? await probeWebSocket({ url: LOCAL_WS, token: localKey, proxy: null })
    : { upgraded: false, status: 0, error: "no 8317 api-keys" };

  const tts = curlIPv4({
    method: "POST",
    url: `${XAI_API}/tts`,
    token,
    body: { text: "hiya", voice_id: "eve", language: "en" },
    binary: true,
  });
  if (tts.status === 200 && tts.body && tts.body.length > 0) {
    writeFileSync(join(WORK, "tts-hiya.bin"), tts.body);
  }

  const verdict = verdictOf({ xaiWs, tts, clientSecrets, localWs, models, voices });
  const ttsNote =
    tts.status === 200
      ? `audio bytes=${tts.bytes} (saved under .work, not repo)`
      : tts.error || tts.network || "";
  const secretNote =
    clientSecrets.status === 200
      ? `issued=${secretMeta.issued} valueLen=${secretMeta.valueLen} expiresAtPresent=${secretMeta.expiresAtPresent}`
      : clientSecrets.error || clientSecrets.network || clientSecrets.code || "";

  const body = [
    `Date: 2026-09-04`,
    `Runner: \`node evals/voice/exp6-grok-voice/probe.mjs\``,
    `Transport: HTTP \`curl -4\` (honors HTTPS_PROXY); remote WS = HTTP CONNECT via ${proxy ? proxy.label : "no-proxy"} then TLS; 8317 loopback direct`,
    ``,
    `### Verdict`,
    ``,
    verdict,
    ``,
    `### Auth`,
    ``,
    `- source: gmail xAI json (type=xai, oauth)`,
    `- oauth access len: ${token.length}`,
    `- expired in past: ${refresh.expired.inPast}`,
    `- expired at: ${refresh.expired.iso || "unknown"}`,
    `- refreshed: ${refresh.refreshed}${refresh.reason && refresh.reason !== "ok" ? ` (${refresh.reason})` : ""}`,
    `- token endpoint host: ${hostOf(auth.token_endpoint)}`,
    `- jwt scope api:access: ${scopes.hasApiAccess}; grok-cli:access: ${scopes.hasGrokCli}`,
    `- env HTTPS_PROXY: ${proxy ? proxy.label : "unset"}`,
    ``,
    `### HTTP`,
    ``,
    `| call | status | transport | note |`,
    `| --- | ---: | --- | --- |`,
    `| GET /v1/models (ids matching /voice\\|realtime\\|tts\\|stt/i) | ${models.status} | ${models.transport || ""} | ids: ${voiceIds.length ? voiceIds.join(", ") : "(none)"}; ${models.error || models.network || ""} |`,
    `| GET /v1/tts/voices | ${voices.status} | ${voices.transport || ""} | voice count=${voiceCount(voices.json)}; ${voices.error || voices.network || ""} |`,
    `| POST /v1/realtime/client_secrets | ${clientSecrets.status} | ${clientSecrets.transport || ""} | ${[clientSecrets.code, secretNote].filter(Boolean).join("; ")} |`,
    `| POST /v1/tts text=hiya voice_id=eve | ${tts.status} | ${tts.transport || ""} | ${[tts.code, ttsNote].filter(Boolean).join("; ")} |`,
    ``,
    `### WebSocket`,
    ``,
    `| target | upgraded | http | first event type | close | note |`,
    `| --- | --- | ---: | --- | --- | --- |`,
    `| wss://api.x.ai/v1/realtime?model=grok-voice-latest | ${xaiWs.upgraded === true} | ${xaiWs.status} | ${xaiWs.firstEventType || "—"} | ${xaiWs.closeCode ?? "—"} ${xaiWs.closeReason || ""} | ${xaiWs.error || xaiWs.network || ""} |`,
    `| ws://127.0.0.1:8317/v1/realtime?model=grok-voice-latest | ${localWs.upgraded === true} | ${localWs.status} | ${localWs.firstEventType || "—"} | ${localWs.closeCode ?? "—"} ${localWs.closeReason || ""} | ${localWs.error || localWs.network || ""}; 8317 api-keys count=${proxyKeys.tried.count} lens=${(proxyKeys.tried.lengths || []).join(",")} |`,
    ``,
    `### 8317 listen`,
    ``,
    "```",
    listen,
    "```",
    ``,
    `### Reading`,
    ``,
    `- Direct Node https to api.x.ai times out on this laptop; curl through the local HTTPS proxy succeeds. Same 7897 path as the product's URLSession pit.`,
    `- Subscription OAuth opened Grok Voice when the WS upgraded and first event was session.created. Catalog omit on GET /v1/models is not a deny.`,
    `- 8317 does not proxy Voice WS (expect a non-101). Product path would be Swift to api.x.ai with OAuth refresh, not 8317.`,
    `- Audio from TTS, if any, is only under \`.work/voice-experiments/exp6/\`.`,
  ].join("\n");

  upsertGrokSection(RESULTS_MD, body);
  const scratch = {
    verdict,
    proxy: proxy ? proxy.label : null,
    modelsStatus: models.status,
    voiceIds,
    voicesStatus: voices.status,
    voiceCount: voiceCount(voices.json),
    clientSecretsStatus: clientSecrets.status,
    clientSecretsCode: clientSecrets.code || null,
    clientSecretsError: clientSecrets.error || null,
    secretIssued: secretMeta.issued,
    xaiWs: {
      upgraded: xaiWs.upgraded,
      status: xaiWs.status,
      firstEventType: xaiWs.firstEventType || null,
      closeCode: xaiWs.closeCode || null,
      closeReason: xaiWs.closeReason || null,
      error: xaiWs.error || null,
      network: xaiWs.network || null,
    },
    localWs: {
      upgraded: localWs.upgraded,
      status: localWs.status,
      firstEventType: localWs.firstEventType || null,
      closeCode: localWs.closeCode || null,
      closeReason: localWs.closeReason || null,
      error: localWs.error || null,
      network: localWs.network || null,
    },
    ttsStatus: tts.status,
    ttsBytes: tts.status === 200 ? tts.bytes : 0,
    refreshed: refresh.refreshed,
    oauthAccessLen: token.length,
  };
  assertSafe("scratch json", JSON.stringify(scratch));
  writeFileSync(join(WORK, "probe.json"), JSON.stringify(scratch, null, 2));
  console.log("wrote Grok Voice section; verdict recorded (no secrets)");
}

main().catch((err) => {
  console.error(redact(err.message || err));
  process.exit(1);
});
