/** Real production stdio path; physical Calculator actions. Does not simulate voice or claim voice acceptance. */
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { makeTurnStartCommand } from "../../packages/runtime/test/fixtures.js";

const root = resolve(import.meta.dirname, "../..");
const store = await mkdtemp(join(tmpdir(), "yishu-codex-eval-"));
const guiEnvironment = process.argv.includes("--gui");
const reportedCommand = process.argv.includes("--reported-command");
const child = spawn(process.execPath, ["--import", "tsx", "src/stdio-server.ts"], {
  cwd: join(root, "packages/runtime"),
  env: { ...(guiEnvironment ? { HOME: process.env.HOME, PATH: "/usr/bin:/bin", TMPDIR: tmpdir() } : process.env),
    YISHU_EVEROS: "0", YISHU_STORE_DIR: store, YISHU_STORE_BACKEND: "json", YISHU_PRODUCT_KERNEL: "1" },
  stdio: ["pipe", "pipe", "ignore"],
});
const command = makeTurnStartCommand();
command.payload.utterance = "请使用官方 Computer Use 操作计算器，清空已有算式，用计算器界面算 29 × 13，读取实际显示结果。只操作计算器，不要用代码计算，最后保留结果显示。";
if (reportedCommand) command.payload.utterance = "打开计算机，然后算一下 31 乘 17";
command.payload.modelPreference = { provider: "openai-codex", model: "gpt-6-astra" };
command.payload.contextFrame.screenshots = [];
command.payload.contextFrame.frontmostApplication = null;
command.payload.contextFrame.activeWindow = null;
command.payload.contextFrame.elementUnderCursor = null;
const started = Date.now();
let tools = 0;
let firstToolMs: number | undefined;
let firstTextMs: number | undefined;
let completed = false;
let terminal = false;
let cancelSentAt: number | undefined;
const cancellationTest = process.argv.includes("--cancel");
const timer = setTimeout(() => {
  child.stdin.write(JSON.stringify({ ...command, type: "turn.cancel", payload: { reason: "eval-timeout" } }) + "\n");
  child.stdin.end(); process.exitCode = 1;
}, 175_000);
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type === "runtime.ready") child.stdin.write(JSON.stringify(command) + "\n");
  if (event.requestId !== command.requestId) return;
  if (event.type === "response.delta" && firstTextMs === undefined) firstTextMs = Date.now() - started;
  if (event.type === "tool.started") {
    firstToolMs ??= Date.now() - started;
    tools++;
    if (cancellationTest && cancelSentAt === undefined) {
      cancelSentAt = Date.now();
      child.stdin.write(JSON.stringify({ ...command, type: "turn.cancel", payload: { reason: "eval-cancel" } }) + "\n");
    }
  }
  // This optional test-only consent is narrowly authorized by the Calculator test request.
  if (event.type === "codex.approval.requested" && process.argv.includes("--accept-calculator")
    && /Calculator|计算器/i.test(event.payload.message)) {
    child.stdin.write(JSON.stringify({ ...command, type: "codex.approval.reply", payload: {
      approvalId: event.payload.approvalId, accept: true,
    } }) + "\n");
  }
  if (["turn.started", "tool.started", "tool.completed", "codex.approval.requested", "response.completed", "turn.failed", "runtime.error"].includes(event.type)) {
    process.stdout.write(JSON.stringify({ seconds: (Date.now() - started) / 1000, type: event.type, payload: event.payload }) + "\n");
  }
  if (["response.completed", "turn.failed", "turn.cancelled", "runtime.error"].includes(event.type)) {
    terminal = true;
    completed = cancellationTest
      ? event.type === "turn.cancelled" && tools === 1 && cancelSentAt !== undefined && Date.now() - cancelSentAt < 5000
      : event.type === "response.completed" && tools > 0 && (reportedCommand ? /527/ : /377/).test(event.payload.text)
        && (!guiEnvironment || (firstToolMs! < 45_000 && Date.now() - started < 90_000));
    clearTimeout(timer);
    process.stdout.write(JSON.stringify({ evaluator: "production-stdio-codex", passed: completed, toolStarts: tools,
      guiEnvironment, reportedCommand, firstTextMs, firstToolMs, totalMs: Date.now() - started,
      voiceTested: false, cancellationTest, cancelMs: cancelSentAt === undefined ? undefined : Date.now() - cancelSentAt }) + "\n");
    process.exitCode = completed ? 0 : 1;
    child.stdin.end();
  }
});
child.on("exit", () => { clearTimeout(timer); if (!terminal) process.exitCode = 1; });
