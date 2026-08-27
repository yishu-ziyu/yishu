import type { BrowserTarget } from "@yishu/kernel";
import type { BrowserDriver, BrowserPageState } from "../src/browser-session.js";

export interface FakeBrowserJar {
  cookies: string[];
}

type FakePage = "home" | "form" | "done";

export class FakeFormDriver implements BrowserDriver {
  readonly jar: FakeBrowserJar;
  private page: FakePage = "home";
  private history: FakePage[] = [];
  private fields: Record<string, string> = {};
  private lastDownload?: string;

  constructor(jar: FakeBrowserJar = { cookies: [] }) {
    this.jar = jar;
  }

  async goto(url: string): Promise<BrowserPageState> {
    this.history.push(this.page);
    if (url.includes("login")) this.jar.cookies = ["session=1"];
    if (url.includes("done") || url.includes("thanks")) this.page = "done";
    else if (url.includes("form")) this.page = "form";
    else this.page = "home";
    this.fields = {};
    return this.snapshot();
  }

  async observe(): Promise<BrowserPageState & { targets: BrowserTarget[] }> {
    const page = this.snapshot();
    return { ...page, targets: page.targets ?? [] };
  }

  async click(targetId: string): Promise<BrowserPageState> {
    if (this.page === "home" && targetId === "1") {
      this.history.push(this.page);
      this.page = "form";
      return this.snapshot();
    }
    if (this.page === "form" && targetId === "3") {
      this.history.push(this.page);
      this.page = "done";
      return this.snapshot();
    }
    throw new Error(`Unknown click target ${targetId} on ${this.page}`);
  }

  async type(targetId: string, text: string, mode: "fill" | "append" = "fill"): Promise<BrowserPageState> {
    const key = targetId === "1" ? "name" : "email";
    this.fields[key] = mode === "append" ? `${this.fields[key] ?? ""}${text}` : text;
    return this.snapshot();
  }

  async scroll(): Promise<BrowserPageState> {
    return this.snapshot("scrolled");
  }

  async extract(): Promise<BrowserPageState> {
    const page = this.snapshot();
    page.extracted = this.page === "done"
      ? `thanks ${this.fields.name ?? ""}`.trim()
      : this.page === "form"
        ? "Name and email form"
        : "Home";
    return page;
  }

  async download(): Promise<BrowserPageState> {
    this.lastDownload = "invoice.txt";
    const page = this.snapshot();
    page.extracted = this.lastDownload;
    return page;
  }

  async close(): Promise<void> {}

  private snapshot(extraTitle?: string): BrowserPageState {
    const url = this.page === "home"
      ? "https://example.test/"
      : this.page === "form"
        ? "https://example.test/form"
        : "https://example.test/thanks";
    const title = extraTitle ?? (this.page === "done" ? "Thanks" : this.page === "form" ? "Form" : "Home");
    return {
      url,
      title,
      tabId: "tab-1",
      targets: this.targets(),
    };
  }

  private targets(): BrowserTarget[] {
    if (this.page === "home") return [{ id: "1", role: "link", name: "Open form" }];
    if (this.page === "form") {
      return [
        { id: "1", role: "textbox", name: "Name" },
        { id: "2", role: "textbox", name: "Email" },
        { id: "3", role: "button", name: "Submit" },
        { id: "4", role: "link", name: "Offscreen help" },
      ];
    }
    return [{ id: "1", role: "heading", name: "Thanks" }];
  }
}
