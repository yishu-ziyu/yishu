import type {
  BrowserExecutor,
  BrowserRequest,
  BrowserResult,
  BrowserTarget,
} from "@yishu/kernel";

export interface BrowserDriver {
  goto(url: string): Promise<{ url: string; title: string }>;
  observe(): Promise<{ url: string; title: string; targets: BrowserTarget[] }>;
  click(targetId: string): Promise<{ url: string; title: string }>;
  type(targetId: string, text: string): Promise<{ url: string; title: string }>;
  close(): Promise<void>;
}

export type BrowserDriverFactory = () => Promise<BrowserDriver>;

interface ConversationBrowser {
  driver: BrowserDriver;
  observedIds: Set<string>;
}

function failed(message: string): BrowserResult {
  return { succeeded: false, verified: false, message };
}

/**
 * One isolated browser session per conversation. Observe must land before
 * click/type. This is not the user's live Chrome window.
 */
export class BrowserSessionHub {
  private readonly sessions = new Map<string, ConversationBrowser>();

  constructor(private readonly openDriver: BrowserDriverFactory) {}

  bind(conversationId: string): BrowserExecutor {
    return {
      perform: (request, signal) => this.perform(conversationId, request, signal),
    };
  }

  async close(conversationId: string): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (!session) return;
    this.sessions.delete(conversationId);
    await session.driver.close().catch(() => undefined);
  }

  async dispose(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.close(id)));
  }

  private async perform(
    conversationId: string,
    request: BrowserRequest,
    signal?: AbortSignal,
  ): Promise<BrowserResult> {
    try {
      if (signal?.aborted) return failed("Browser action was cancelled.");
      if (request.op === "close") {
        await this.close(conversationId);
        return { succeeded: true, verified: true, message: "Browser session closed." };
      }

      const session = await this.ensureSession(conversationId);
      if (signal?.aborted) return failed("Browser action was cancelled.");

      if (request.op === "goto") {
        const page = await session.driver.goto(request.url);
        session.observedIds.clear();
        return {
          succeeded: true,
          verified: true,
          message: "Opened page.",
          url: page.url,
          title: page.title,
        };
      }

      if (request.op === "observe") {
        const page = await session.driver.observe();
        session.observedIds = new Set(page.targets.map((target) => target.id));
        return {
          succeeded: true,
          verified: true,
          message: `Observed ${page.targets.length} targets.`,
          url: page.url,
          title: page.title,
          targets: page.targets,
        };
      }

      if (!session.observedIds.has(request.targetId)) {
        return failed("Observe the page before using a numbered target.");
      }

      const page = request.op === "click"
        ? await session.driver.click(request.targetId)
        : await session.driver.type(request.targetId, request.text);
      session.observedIds.clear();
      return {
        succeeded: true,
        verified: true,
        message: request.op === "click" ? "Clicked target." : "Typed into target.",
        url: page.url,
        title: page.title,
      };
    } catch (error) {
      return failed(error instanceof Error ? error.message : "Browser driver failed.");
    }
  }

  private async ensureSession(conversationId: string): Promise<ConversationBrowser> {
    const existing = this.sessions.get(conversationId);
    if (existing) return existing;
    const driver = await this.openDriver();
    const created: ConversationBrowser = { driver, observedIds: new Set() };
    this.sessions.set(conversationId, created);
    return created;
  }
}
