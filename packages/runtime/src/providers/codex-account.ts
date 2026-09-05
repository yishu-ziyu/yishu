import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import type { OAuthInteraction } from "../model-loop/oauth.js";

export const codexWorkingDirectory = () => join(homedir(), "Library/Application Support/Yishu/Codex");

export class CodexAccount {
  private cached: { at: number; account: { email?: string } | undefined; models: { id: string; name: string }[] } | undefined;

  private async client(): Promise<CodexAppServerClient> {
    const cwd = codexWorkingDirectory();
    await mkdir(cwd, { recursive: true });
    const client = new CodexAppServerClient({ cwd });
    try { await client.initialize(); return client; } catch (error) { await client.close(); throw error; }
  }

  async read() {
    if (this.cached && Date.now() - this.cached.at < 5_000) return this.cached;
    const client = await this.client();
    try {
      const { account } = await client.request("account/read", {});
      const { data } = await client.request("model/list", { limit: 100 });
      this.cached = {
        at: Date.now(),
        account: account?.type === "chatgpt" ? { email: account.email } : undefined,
        models: (data ?? []).map((model: { model: string; displayName: string }) => ({
          id: model.model, name: model.displayName,
        })),
      };
      return this.cached;
    } finally { await client.close(); }
  }

  async login(interaction: OAuthInteraction): Promise<unknown> {
    const client = await this.client();
    let unsubscribe = () => {};
    let timer: NodeJS.Timeout | undefined;
    const abort = () => { void client.close(); };
    interaction.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (interaction.signal?.aborted) throw new Error("Login cancelled");
      const done = new Promise<void>((resolve, reject) => {
        unsubscribe = client.subscribe((message) => {
          if (message.method === "account/login/completed") {
            if (message.params?.success) resolve();
            else reject(new Error("Codex 登录未完成。"));
          }
          if (message.method === "yishu/closed") reject(new Error("Login cancelled"));
        });
        timer = setTimeout(() => reject(new Error("Codex 登录超时。")), 180_000);
      });
      // Attach immediately so startup failures cannot leave an unhandled rejection.
      void done.catch(() => {});
      const result = await client.request("account/login/start", { type: "chatgpt" });
      interaction.notify({ type: "auth_url", url: result.authUrl });
      await done;
      this.cached = undefined;
      return (await this.read()).account;
    } finally {
      unsubscribe();
      if (timer) clearTimeout(timer);
      interaction.signal?.removeEventListener("abort", abort);
      await client.close();
    }
  }

  async logout(): Promise<void> {
    const client = await this.client();
    try { await client.request("account/logout", {}); this.cached = undefined; }
    finally { await client.close(); }
  }
}
