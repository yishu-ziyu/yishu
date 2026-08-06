import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runtimeDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const mode of ["mock", "pi", "agent-core"] as const) {
  test(`stdio server boots and pongs in ${mode} mode`, async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/stdio-server.ts"], {
      cwd: runtimeDirectory,
      env: {
        ...process.env,
        YISHU_RUNTIME_MODE: mode,
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "ignore"],
    });

    let buffer = "";
    let sawReady = false;
    const requestId = randomUUID();
    const traceId = randomUUID();

    await new Promise<void>((resolve, reject) => {
      // Full suite load + heavier dependency graph can push cold start past 8s.
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`${mode} runtime did not answer ping in time`));
      }, 20_000);

      child.once("exit", (code) => {
        if (!sawReady) {
          clearTimeout(timeout);
          reject(new Error(`${mode} runtime exited before ready with code ${String(code)}`));
        }
      });

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as {
            type?: string;
            requestId?: string;
            payload?: { mode?: string };
          };

          if (event.type === "runtime.ready" && !sawReady) {
            sawReady = true;
            assert.equal(event.payload?.mode, mode);
            child.stdin.write(`${JSON.stringify({
              schemaVersion: 1,
              type: "runtime.ping",
              requestId,
              traceId,
              sentAt: new Date().toISOString(),
              payload: {},
            })}\n`);
          }

          if (event.type === "runtime.pong" && event.requestId === requestId) {
            clearTimeout(timeout);
            child.kill("SIGTERM");
            resolve();
          }
        }
      });
    });
  });
}
