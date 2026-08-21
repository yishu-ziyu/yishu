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

  async type(targetId: string, text: string): Promise<{ url: string; title: string }> {
    const locator = this.page.locator(`[data-yishu-target="${targetId}"]`);
    if (!(await locator.isVisible())) {
      throw new Error(`Target ${targetId} is no longer on the page.`);
    }
    await locator.fill(text);
    return this.location();
  }

  async close(): Promise<void> {
    await this.stagehand.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }

  private async location(): Promise<{ url: string; title: string }> {
    return { url: await this.page.url(), title: await this.page.title() };
  }
}
