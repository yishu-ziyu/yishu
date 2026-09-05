import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface CodexMessage {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

export function codexChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) =>
    /^(HOME|PATH|USER|LOGNAME|SHELL|TMPDIR|LANG|LC_.*|TERM|NO_COLOR|https?_proxy|all_proxy|no_proxy)$/i.test(key)));
}

export function codexExecutable(): string {
  const candidates = [process.env.YISHU_CODEX_EXECUTABLE,
    // GUI apps do not inherit the terminal's Node PATH. Prefer the native binary.
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    join(homedir(), ".local/bin/codex")];
  return candidates.find((path) => path && existsSync(path)) ?? "codex";
}

/** Owns exactly one CLI process group. Never opens Codex's credential files. */
export class CodexAppServerClient {
  private sequence = 0;
  private closed = false;
  private readonly pending = new Map<number, {
    resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout;
  }>();
  private readonly listeners = new Set<(message: CodexMessage) => void>();
  readonly process: ChildProcessWithoutNullStreams;

  constructor(options: { cwd: string; executable?: string; args?: string[] }) {
    this.process = spawn(options.executable ?? codexExecutable(), options.args ?? [
      "app-server", "-c", "features.memories=false", "-c", "features.chronicle=false",
      "-c", "features.hooks=false",
      // GUI-launched Codex timed out on WebSocket six times before HTTP worked.
      // A process-local provider selects that same subscription transport directly.
      // Built-in provider IDs are reserved, so keep this override private to Yishu.
      "-c", 'model_provider="yishu-chatgpt-http"',
      "-c", 'model_providers.yishu-chatgpt-http={name="OpenAI",wire_api="responses",requires_openai_auth=true,supports_websockets=false}',
    ], { cwd: options.cwd, env: codexChildEnvironment(process.env), detached: true, stdio: "pipe" });
    const lines = createInterface({ input: this.process.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let message: CodexMessage;
      try { message = JSON.parse(line); } catch { this.fail(new Error("Codex 返回了无效的 JSON。")); return; }
      if (message.method) {
        for (const listener of this.listeners) listener(message);
      } else if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`Codex RPC ${message.error.code}: ${message.error.message}`));
        else pending.resolve(message.result);
      }
    });
    // stderr can contain private context; drain without persisting or projecting it.
    this.process.stderr.resume();
    this.process.stdin.on("error", () => this.fail(new Error("Codex 输入通道已关闭。")));
    this.process.on("error", () => this.fail(new Error("无法启动本机 Codex CLI。")));
    this.process.on("exit", () => this.fail(new Error("Codex 执行进程已退出。")));
  }

  subscribe(listener: (message: CodexMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "yishu", title: "奕枢", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized", params: {} });
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Codex 执行通道已关闭。"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} 等待超时。`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  send(message: CodexMessage): void {
    if (!this.closed) this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.listeners) listener({ method: "yishu/closed", params: {} });
  }

  async close(): Promise<void> {
    this.fail(new Error("Codex 执行通道已关闭。"));
    const pid = this.process.pid;
    if (!pid) return;
    // The npm CLI launcher can leave its binary child alive if only the launcher is killed.
    const killGroup = (signal: NodeJS.Signals) => {
      try { process.kill(-pid, signal); } catch { /* already gone */ }
    };
    killGroup("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { killGroup("SIGKILL"); resolve(); }, 750);
      this.process.once("close", () => { clearTimeout(timer); killGroup("SIGKILL"); resolve(); });
    });
  }
}
