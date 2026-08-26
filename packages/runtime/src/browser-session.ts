import type {
  BrowserExecutor,
  BrowserRequest,
  BrowserResult,
  BrowserTarget,
} from "@yishu/kernel";

export interface BrowserPageState {
  url: string;
  title: string;
  targets?: BrowserTarget[];
  extracted?: string;
  tabId?: string;
}

export interface BrowserDriver {
  goto(url: string): Promise<BrowserPageState>;
  observe(mode?: "interactive" | "content" | "both"): Promise<BrowserPageState & { targets: BrowserTarget[] }>;
  click(targetId: string): Promise<BrowserPageState>;
  type(targetId: string, text: string, mode?: "fill" | "append"): Promise<BrowserPageState>;
  close(): Promise<void>;
  select?(targetId: string, value: string): Promise<BrowserPageState>;
  check?(targetId: string, checked: boolean): Promise<BrowserPageState>;
  scroll?(direction: "up" | "down", amount: "small" | "page" | "end"): Promise<BrowserPageState>;
  back?(): Promise<BrowserPageState>;
  forward?(): Promise<BrowserPageState>;
  reload?(): Promise<BrowserPageState>;
  waitFor?(
    condition: "url" | "title" | "target" | "text" | "network_idle" | "download",
    timeoutMs?: number,
  ): Promise<BrowserPageState & { matched: boolean }>;
  extract?(targetId?: string, format?: "text" | "markdown" | "table"): Promise<BrowserPageState>;
  openTab?(url?: string): Promise<BrowserPageState>;
  switchTab?(tabId: string): Promise<BrowserPageState>;
  closeTab?(tabId?: string): Promise<BrowserPageState>;
  upload?(targetId: string, workspaceFileId: string): Promise<BrowserPageState>;
  download?(targetId: string): Promise<BrowserPageState>;
}

export type BrowserDriverFactory = () => Promise<BrowserDriver>;

interface ConversationBrowser {
  driver: BrowserDriver;
  observedIds: Set<string>;
}

function failed(message: string): BrowserResult {
  return { succeeded: false, verified: false, message };
}

function pageResult(message: string, page: BrowserPageState, extra?: Partial<BrowserResult>): BrowserResult {
  const result: BrowserResult = {
    succeeded: true,
    verified: true,
    message,
    url: page.url,
    title: page.title,
  };
  if (page.targets !== undefined) result.targets = page.targets;
  if (page.extracted !== undefined) result.extracted = page.extracted;
  if (page.tabId !== undefined) result.tabId = page.tabId;
  return extra === undefined ? result : { ...result, ...extra };
}

function missingDriverOp(op: string): BrowserResult {
  return failed(`Browser driver does not implement ${op}.`);
}

/**
 * One isolated browser session per conversation. Numbered targets expire after
 * any navigation or mutation. This is not the user's live Chrome window.
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
        return pageResult("Opened page.", page);
      }

      if (request.op === "observe") {
        const page = await session.driver.observe(request.mode);
        session.observedIds = new Set(page.targets.map((target) => target.id));
        return pageResult(`Observed ${page.targets.length} targets.`, page, { targets: page.targets });
      }

      if (request.op === "extract") {
        if (session.driver.extract === undefined) return missingDriverOp("extract");
        const page = await session.driver.extract(request.targetId, request.format);
        return pageResult("Extracted page content.", page);
      }

      if (request.op === "wait_for") {
        if (session.driver.waitFor === undefined) return missingDriverOp("wait_for");
        const page = await session.driver.waitFor(request.condition, request.timeoutMs);
        return pageResult(
          page.matched ? "Wait condition matched." : "Wait condition did not match.",
          page,
          { verified: page.matched },
        );
      }

      if (request.op === "scroll") {
        if (session.driver.scroll === undefined) return missingDriverOp("scroll");
        const page = await session.driver.scroll(request.direction, request.amount);
        session.observedIds.clear();
        return pageResult("Scrolled page.", page);
      }

      if (request.op === "back") {
        if (session.driver.back === undefined) return missingDriverOp("back");
        const page = await session.driver.back();
        session.observedIds.clear();
        return pageResult("Navigated back.", page);
      }

      if (request.op === "forward") {
        if (session.driver.forward === undefined) return missingDriverOp("forward");
        const page = await session.driver.forward();
        session.observedIds.clear();
        return pageResult("Navigated forward.", page);
      }

      if (request.op === "reload") {
        if (session.driver.reload === undefined) return missingDriverOp("reload");
        const page = await session.driver.reload();
        session.observedIds.clear();
        return pageResult("Reloaded page.", page);
      }

      if (request.op === "open_tab") {
        if (session.driver.openTab === undefined) return missingDriverOp("open_tab");
        const page = await session.driver.openTab(request.url);
        session.observedIds.clear();
        return pageResult("Opened tab.", page);
      }

      if (request.op === "switch_tab") {
        if (session.driver.switchTab === undefined) return missingDriverOp("switch_tab");
        const page = await session.driver.switchTab(request.tabId);
        session.observedIds.clear();
        return pageResult("Switched tab.", page);
      }

      if (request.op === "close_tab") {
        if (session.driver.closeTab === undefined) return missingDriverOp("close_tab");
        const page = await session.driver.closeTab(request.tabId);
        session.observedIds.clear();
        return pageResult("Closed tab.", page);
      }

      if (request.op === "select" || request.op === "check" || request.op === "click" || request.op === "type" || request.op === "upload" || request.op === "download") {
        if (!session.observedIds.has(request.targetId)) {
          return failed("Observe the page before using a numbered target.");
        }
      }

      if (request.op === "click") {
        const page = await session.driver.click(request.targetId);
        session.observedIds.clear();
        return pageResult("Clicked target.", page);
      }

      if (request.op === "type") {
        const page = await session.driver.type(request.targetId, request.text, request.mode);
        session.observedIds.clear();
        return pageResult("Typed into target.", page);
      }

      if (request.op === "select") {
        if (session.driver.select === undefined) return missingDriverOp("select");
        const page = await session.driver.select(request.targetId, request.value);
        session.observedIds.clear();
        return pageResult("Selected value.", page);
      }

      if (request.op === "check") {
        if (session.driver.check === undefined) return missingDriverOp("check");
        const page = await session.driver.check(request.targetId, request.checked);
        session.observedIds.clear();
        return pageResult(request.checked ? "Checked target." : "Unchecked target.", page);
      }

      if (request.op === "upload") {
        if (session.driver.upload === undefined) return missingDriverOp("upload");
        const page = await session.driver.upload(request.targetId, request.workspaceFileId);
        session.observedIds.clear();
        return pageResult("Uploaded workspace file.", page);
      }

      if (request.op === "download") {
        if (session.driver.download === undefined) return missingDriverOp("download");
        const page = await session.driver.download(request.targetId);
        session.observedIds.clear();
        return pageResult("Started download.", page);
      }

      return failed("Browser driver does not implement this operation.");
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
