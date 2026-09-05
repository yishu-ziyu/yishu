#!/usr/bin/env node
import { createServer } from "node:http";
import { open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FILE_NAME = "奕枢测试文件.txt";
const REQUIRED_DROPS = 3;
const TIMEOUT_MS = 180_000;
const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "file-drop.html");
const downloadPath = join(homedir(), "Downloads", FILE_NAME);
const fixture = await readFile(fixturePath);
let createdTestFile = false;
let finished = false;
const state = { drop: 0, submit: 0, invalid: 0, names: [] };

async function cleanup() {
  if (createdTestFile) await unlink(downloadPath).catch(() => undefined);
}

async function finish(exitCode, reason) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  await new Promise((resolve) => server.close(resolve));
  await cleanup();
  process.stdout.write(`${JSON.stringify({
    evaluator: "m1-file-upload-drag",
    passed: exitCode === 0,
    reason,
    expectedFileName: FILE_NAME,
    ...state,
  })}\n`);
  process.exitCode = exitCode;
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(fixture);
    return;
  }
  if (request.method === "GET" && request.url === "/state") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(state));
    return;
  }
  if (request.method === "POST" && request.url === "/event") {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 4096) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    let event;
    try {
      event = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (event?.type === "submit") state.submit += 1;
    if (event?.type === "drop") {
      const names = Array.isArray(event.names) ? event.names : [];
      state.names.push(names);
      if (names.length === 1 && names[0] === FILE_NAME) state.drop += 1;
      else state.invalid += 1;
    }
    response.writeHead(204).end();
    if (state.submit > 0) void finish(1, "submit_observed");
    else if (state.invalid > 0) void finish(1, "unexpected_drop_payload");
    else if (state.drop === REQUIRED_DROPS) void finish(0, "three_verified_drops_without_submit");
    return;
  }
  response.writeHead(404).end();
});

try {
  const handle = await open(downloadPath, "wx", 0o600);
  await handle.writeFile("Yishu M1 local file-drop acceptance fixture.\n", "utf8");
  await handle.close();
  createdTestFile = true;
} catch (error) {
  process.stderr.write(`Refusing to overwrite existing Downloads/${FILE_NAME}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

if (!createdTestFile) process.exit();

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (typeof address === "string" || address === null) throw new Error("Loopback evaluator did not bind a TCP port.");
process.stdout.write(`Open http://127.0.0.1:${address.port}/ in the visible browser.\n`);
process.stdout.write(`Say: 把下载里的 ${FILE_NAME} 拖到这个上传框；then say: 去。Repeat three times.\n`);

const timeout = setTimeout(() => void finish(1, "timeout_before_three_drops"), TIMEOUT_MS);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void finish(1, `interrupted_${signal.toLowerCase()}`));
}
