import { localBrowser, Stagehand, type Page, type StagehandBrowser } from "@browserbasehq/stagehand";
import type { BrowserTarget } from "@yishu/kernel";
import type { BrowserDriver } from "./browser-session.js";

const COLLECT_NUMBERED_TARGETS = `() => {
  const selector = "a[href], button, input, textarea, select, [role='button'], [role='link'], [role='textbox'], [role='checkbox'], [role='menuitem']";
  const nodes = Array.from(document.querySelectorAll(selector));
  const visible = nodes.filter((node) => {
    if (!(node instanceof HTMLElement)) return false;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }).slice(0, 50);
  for (const node of visible) node.removeAttribute("data-yishu-target");
  return visible.map((node, index) => {
    const id = String(index + 1);
    node.setAttribute("data-yishu-target", id);
    const role = node.getAttribute("role") || node.tagName.toLowerCase();
    const name = (
      node.getAttribute("aria-label")
      || node.getAttribute("placeholder")
      || (node instanceof HTMLInputElement ? node.value : "")
      || node.innerText
      || ""
    ).trim().slice(0, 120);
    return { id, role, name };
  });
}`;

/**
 * Stagehand as a Playwright-level hand. Numbered targets come from the DOM.
 * Do not call Stagehand.act / observe / extract — those start a nested model.
 */
export async function openStagehandDriver(): Promise<BrowserDriver> {
  const browser = await localBrowser.launch({ headless: true });
  const stagehand = await Stagehand.create({ browser });
  const page = await browser.context.activePage()
    ?? (await browser.context.pages())[0];
  if (!page) {
    await stagehand.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    throw new Error("Stagehand launched without a page.");
  }
  return new StagehandPageDriver(browser, page, stagehand);
}

class StagehandPageDriver implements BrowserDriver {
  constructor(
    private readonly browser: StagehandBrowser,
    private readonly page: Page,
    private readonly stagehand: Stagehand,
  ) {}

  async goto(url: string): Promise<{ url: string; title: string }> {
    await this.page.goto(url);
    return this.location();
  }

  async observe(): Promise<{ url: string; title: string; targets: BrowserTarget[] }> {
    const targets = await this.page.evaluate(COLLECT_NUMBERED_TARGETS) as BrowserTarget[];
    const location = await this.location();
    return { ...location, targets: Array.isArray(targets) ? targets : [] };
  }

  async click(targetId: string): Promise<{ url: string; title: string }> {
    const locator = this.page.locator(`[data-yishu-target="${targetId}"]`);
    if (!(await locator.isVisible())) {
      throw new Error(`Target ${targetId} is no longer on the page.`);
    }
    await locator.click();
    return this.location();
  }

  async type(targetId: string, text: string, mode: "fill" | "append" = "fill"): Promise<{ url: string; title: string }> {
    const locator = this.page.locator(`[data-yishu-target="${targetId}"]`);
    if (!(await locator.isVisible())) {
      throw new Error(`Target ${targetId} is no longer on the page.`);
    }
    if (mode === "append") {
      await this.page.evaluate(`(() => {
        const node = document.querySelector('[data-yishu-target="${targetId}"]');
        if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
          node.value = (node.value || "") + ${JSON.stringify(text)};
          node.dispatchEvent(new Event("input", { bubbles: true }));
        }
      })()`);
    } else {
      await locator.fill(text);
    }
    return this.location();
  }

  async select(targetId: string, value: string): Promise<{ url: string; title: string }> {
    await this.page.evaluate(`(() => {
      const node = document.querySelector('[data-yishu-target="${JSON.stringify(targetId).slice(1, -1)}"]');
      if (!(node instanceof HTMLSelectElement)) throw new Error("Target is not a select.");
      node.value = ${JSON.stringify(value)};
      node.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    return this.location();
  }

  async check(targetId: string, checked: boolean): Promise<{ url: string; title: string }> {
    await this.page.evaluate(`(() => {
      const node = document.querySelector('[data-yishu-target="${JSON.stringify(targetId).slice(1, -1)}"]');
      if (!(node instanceof HTMLInputElement)) throw new Error("Target is not an input.");
      node.checked = ${checked ? "true" : "false"};
      node.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    return this.location();
  }

  async scroll(direction: "up" | "down", amount: "small" | "page" | "end"): Promise<{ url: string; title: string }> {
    const delta = amount === "small" ? 240 : amount === "page" ? 900 : 20_000;
    await this.page.evaluate(`window.scrollBy(0, ${direction === "down" ? delta : -delta})`);
    return this.location();
  }

  async back(): Promise<{ url: string; title: string }> {
    await this.page.evaluate("history.back()");
    return this.location();
  }

  async forward(): Promise<{ url: string; title: string }> {
    await this.page.evaluate("history.forward()");
    return this.location();
  }

  async reload(): Promise<{ url: string; title: string }> {
    await this.page.evaluate("location.reload()");
    return this.location();
  }

  async extract(targetId?: string, format: "text" | "markdown" | "table" = "text"): Promise<{ url: string; title: string; extracted: string }> {
    const extracted = await this.page.evaluate(`(() => {
      const node = ${targetId === undefined ? "document.body" : `document.querySelector('[data-yishu-target="${JSON.stringify(targetId).slice(1, -1)}"]')`};
      if (!node) return "";
      if (${JSON.stringify(format)} === "table") {
        return Array.from(node.querySelectorAll("table")).map((table) => table.innerText).join("\\n\\n");
      }
      return node.innerText.slice(0, 8000);
    })()`) as string;
    return { ...(await this.location()), extracted: typeof extracted === "string" ? extracted : "" };
  }

  async waitFor(
    condition: "url" | "title" | "target" | "text" | "network_idle" | "download",
    timeoutMs = 8_000,
  ): Promise<{ url: string; title: string; matched: boolean }> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const location = await this.location();
      if (condition === "url" && location.url.length > 0) return { ...location, matched: true };
      if (condition === "title" && location.title.length > 0) return { ...location, matched: true };
      if (condition === "network_idle") return { ...location, matched: true };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { ...(await this.location()), matched: false };
  }

  async close(): Promise<void> {
    await this.stagehand.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }

  private async location(): Promise<{ url: string; title: string }> {
    return { url: await this.page.url(), title: await this.page.title() };
  }
}
