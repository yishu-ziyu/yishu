import assert from "node:assert/strict";
import test from "node:test";
import {
  createYishuKernel,
  isAllowedBrowserUrl,
  type BrowserRequest,
  type BrowserResult,
  type BrowserTarget,
} from "@yishu/kernel";
import { browserUrlIsAllowed } from "../src/browser/browser-policy.js";
import { BrowserSessionHub, type BrowserDriver } from "../src/browser-session.js";
import { openStagehandDriver } from "../src/stagehand-browser-driver.js";
import { startBrowserFixtureServer } from "../../../script/serve-browser-fixture.mjs";

const STAGEHAND_LAUNCH_MS = 25_000;

type LiveTarget = BrowserTarget & {
  tag: string;
  href?: string;
  inputName?: string;
  submit?: boolean;
};

class HtmlFixtureDriver implements BrowserDriver {
  private url = "";
  private title = "";
  private html = "";
  private live: LiveTarget[] = [];
  private readonly fields = new Map<string, string>();

  async goto(url: string) {
    await this.load(url);
    return this.snapshot();
  }

  async observe() {
    this.live = parseTargets(this.html);
    return { ...this.snapshot(), targets: this.live.map(toTarget) };
  }

  async click(targetId: string) {
    const target = this.live.find((entry) => entry.id === targetId);
    if (target === undefined) throw new Error(`Target ${targetId} is no longer on the page.`);
    if (target.href !== undefined) {
      await this.load(new URL(target.href, this.url).href);
      return this.snapshot();
    }
    if (target.submit === true) {
      const action = formAction(this.html);
      const dest = new URL(action, this.url);
      for (const [name, value] of this.fields) dest.searchParams.set(name, value);
      await this.load(dest.href);
      return this.snapshot();
    }
    throw new Error(`Unknown click target ${targetId}`);
  }

  async type(targetId: string, text: string, mode: "fill" | "append" = "fill") {
    const target = this.live.find((entry) => entry.id === targetId);
    if (target?.inputName === undefined) {
      throw new Error(`Target ${targetId} is no longer on the page.`);
    }
    const previous = this.fields.get(target.inputName) ?? "";
    this.fields.set(target.inputName, mode === "append" ? `${previous}${text}` : text);
    return this.snapshot();
  }

  async extract() {
    return { ...this.snapshot(), extracted: visibleText(this.html) };
  }

  async close() {}

  private async load(url: string) {
    const response = await fetch(url);
    this.html = await response.text();
    this.url = response.url || url;
    this.title = titleOf(this.html);
    this.live = [];
  }

  private snapshot() {
    return { url: this.url, title: this.title };
  }
}

function toTarget(target: LiveTarget): BrowserTarget {
  return { id: target.id, role: target.role, name: target.name };
}

function titleOf(html: string): string {
  return /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
}

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function attr(attrs: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  return match?.[2] ?? match?.[3] ?? match?.[4];
}

function formAction(html: string): string {
  const match = /<form\b([^>]*)>/i.exec(html);
  return match?.[1] !== undefined ? (attr(match[1], "action") ?? "thanks.html") : "thanks.html";
}

function parseTargets(html: string): LiveTarget[] {
  const targets: LiveTarget[] = [];
  const token = /<(a|button|input|textarea|select)\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = token.exec(html)) !== null && targets.length < 50) {
    const tag = match[1]?.toLowerCase() ?? "";
    const attrs = match[2] ?? "";
    if (attr(attrs, "type")?.toLowerCase() === "hidden") continue;
    const id = String(targets.length + 1);
    const role = attr(attrs, "role") || tag;
    let inner = "";
    if (tag === "a" || tag === "button" || tag === "textarea" || tag === "select") {
      const close = html.toLowerCase().indexOf(`</${tag}>`, match.index);
      if (close >= 0) inner = html.slice(match.index + match[0].length, close);
    }
    const name = (
      attr(attrs, "aria-label")
      || attr(attrs, "placeholder")
      || (tag === "input" ? attr(attrs, "value") : undefined)
      || inner.replace(/<[^>]+>/g, " ")
      || ""
    ).replace(/\s+/g, " ").trim().slice(0, 120);
    const live: LiveTarget = { id, role, name, tag };
    const href = attr(attrs, "href");
    if (href !== undefined) live.href = href;
    const inputName = attr(attrs, "name");
    if (inputName !== undefined) live.inputName = inputName;
    const type = attr(attrs, "type")?.toLowerCase();
    if (tag === "button" && type !== "button" && type !== "reset") live.submit = true;
    if (tag === "input" && type === "submit") live.submit = true;
    targets.push(live);
  }
  return targets;
}

async function invokeBrowser(
  kernel: ReturnType<typeof createYishuKernel>,
  executor: { perform: (request: BrowserRequest, signal?: AbortSignal) => Promise<BrowserResult> },
  input: BrowserRequest,
): Promise<BrowserResult> {
  const receipt = await kernel.registry.invoke("browser", {
    caller: "pi",
    input,
  }, { browser: executor });
  return (receipt.output ?? {}) as BrowserResult;
}

async function runSixStepForm(
  perform: (input: BrowserRequest) => Promise<BrowserResult>,
  origin: string,
): Promise<number> {
  const home = `${origin}/`;
  const opened = await perform({ op: "goto", url: home });
  assert.equal(opened.succeeded, true, opened.message);

  const observedHome = await perform({ op: "observe" });
  assert.equal(observedHome.targets?.[0]?.id, "1");

  const navigated = await perform({ op: "click", targetId: "1" });
  assert.equal(navigated.succeeded, true, navigated.message);

  let reobserves = 0;
  const stale = await perform({ op: "click", targetId: "1" });
  assert.equal(stale.succeeded, false, "stale target after navigation must fail before reobserve");
  assert.match(stale.message, /Observe the page/);

  const observedForm = await perform({ op: "observe" });
  reobserves += 1;
  assert.ok((observedForm.targets?.length ?? 0) >= 3, "form observe should number name, email, submit");

  const named = await perform({ op: "type", targetId: "1", text: "Ada" });
  assert.equal(named.succeeded, true, named.message);
  await perform({ op: "observe" });
  const emailed = await perform({ op: "type", targetId: "2", text: "ada@example.test" });
  assert.equal(emailed.succeeded, true, emailed.message);
  await perform({ op: "observe" });

  const submitted = await perform({ op: "click", targetId: "3" });
  assert.equal(submitted.succeeded, true, submitted.message);
  assert.match(submitted.title ?? "", /Thanks/i);

  const extracted = await perform({ op: "extract", format: "text" });
  assert.match(extracted.extracted ?? "", /thanks Ada/);
  return reobserves;
}

async function tryOpenStagehandDriver(): Promise<
  { status: "ok"; driver: BrowserDriver } | { status: "unavailable"; reason: string }
> {
  const launch = openStagehandDriver();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const driver = await Promise.race([
      launch,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Stagehand launch timed out")), STAGEHAND_LAUNCH_MS);
      }),
    ]);
    return { status: "ok", driver };
  } catch (error) {
    void launch.then((driver) => driver.close()).catch(() => undefined);
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "unavailable", reason: `Chromium unavailable: ${reason}` };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("fixture HTML is served on loopback and production URL policy allows only that private path", async (t) => {
  const server = await startBrowserFixtureServer();
  t.after(() => server.close());
  const fixtureUrl = `${server.origin}/form.html`;
  const page = await fetch(fixtureUrl).then((response) => response.text());
  assert.match(page, /aria-label="Name"/);
  assert.match(page, /aria-label="Submit"/);
  assert.equal(isAllowedBrowserUrl(fixtureUrl), false);
  assert.equal(isAllowedBrowserUrl(fixtureUrl, { allowLocalFixture: true }), true);
  assert.equal(browserUrlIsAllowed(fixtureUrl, { allowLocalFixture: true }), true);
  assert.equal(browserUrlIsAllowed("http://192.168.0.5/form.html", { allowLocalFixture: true }), false);
  assert.equal(isAllowedBrowserUrl("file:///etc/passwd", { allowLocalFixture: true }), false);
});

test("HtmlFixtureDriver six-step form reobserves after navigation (0 → 1)", async (t) => {
  const server = await startBrowserFixtureServer();
  t.after(() => server.close());
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const hub = new BrowserSessionHub(async () => new HtmlFixtureDriver());
  t.after(() => hub.dispose());
  const executor = hub.bind("fixture-html");
  const perform = (input: BrowserRequest) => invokeBrowser(kernel, executor, input);
  const reobserves = await runSixStepForm(perform, server.origin);
  assert.equal(reobserves, 1);
});

test("Stagehand Chromium six-step form against the loopback fixture", { timeout: 60_000 }, async (t) => {
  const opened = await tryOpenStagehandDriver();
  if (opened.status === "unavailable") {
    t.skip(opened.reason);
    return;
  }
  t.after(() => opened.driver.close());
  const server = await startBrowserFixtureServer();
  const hub = new BrowserSessionHub(async () => opened.driver);
  t.after(async () => {
    await hub.dispose();
    await server.close();
  });
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const executor = hub.bind("fixture-stagehand");
  const perform = (input: BrowserRequest) => invokeBrowser(kernel, executor, input);
  const rfc1918 = await perform({ op: "goto", url: "http://192.168.1.20/admin" });
  assert.equal(rfc1918.succeeded, false);
  const reobserves = await runSixStepForm(perform, server.origin);
  assert.equal(reobserves, 1);
});
