#!/usr/bin/env node
/**
 * Outside-process Testbed e2e. Launch a real window, AX-press from a second
 * process, read `testbed-effect`. In-process XCTest is not a user-visible pass.
 * Accessibility TCC denial fails closed.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, existsSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCENARIO_DIR = path.join(ROOT, "e2e/macos/scenarios");
const REPORTS = path.join(ROOT, "e2e/macos/reports");
const BUNDLE_ID = "works.earendil.YishuTestbed";
const EFFECT_ID = "testbed-effect";

type DriverPayload = {
  ok?: boolean;
  axTrusted?: boolean;
  reason?: string;
  value?: string | null;
  effect?: string | null;
  identifier?: string;
};

type ScenarioResult = {
  id: string;
  app: string;
  fixture: string;
  evidenceKind: "outside-process-ax" | "outside-process-ax-denied";
  passed: boolean;
  falseCompletionCount: number;
  reason: string;
  effect?: string;
};

function yamlField(text: string, key: string): string {
  return new RegExp(`^${key}:\\s+(\\S+)`, "m").exec(text)?.[1] ?? "";
}

function parseScenarios(): Array<{ file: string; id: string; fixture: string; expectedTerminal: string }> {
  const files = readdirSync(SCENARIO_DIR).filter((name) => name.endsWith(".yaml")).sort();
  if (files.length === 0) throw new Error("no e2e scenarios");
  return files.map((file) => {
    const text = readFileSync(path.join(SCENARIO_DIR, file), "utf8");
    return {
      file,
      id: yamlField(text, "id") || file,
      fixture: yamlField(text, "fixture") || "single-button",
      expectedTerminal: /task_terminal:\s+(\S+)/.exec(text)?.[1] ?? "verified",
    };
  });
}

function swiftBinPath(): string {
  const shown = spawnSync("swift", ["build", "--package-path", "apps/yishu-testbed", "--show-bin-path"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (shown.status !== 0) {
    throw new Error(shown.stderr || "swift --show-bin-path failed");
  }
  return shown.stdout.trim();
}

function buildTestbed(): { appBinary: string; driver: string } {
  const build = spawnSync("swift", ["build", "--package-path", "apps/yishu-testbed"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (build.status !== 0) {
    throw new Error(build.stderr || build.stdout || "swift build testbed failed");
  }
  const bin = swiftBinPath();
  const testbedBinary = path.join(bin, "YishuTestbed");
  const driver = path.join(bin, "YishuTestbedDriver");
  if (!existsSync(testbedBinary) || !existsSync(driver)) {
    throw new Error(`missing testbed binaries in ${bin}`);
  }
  const appDir = path.join(bin, "YishuTestbed.app/Contents");
  mkdirSync(path.join(appDir, "MacOS"), { recursive: true });
  const appBinary = path.join(appDir, "MacOS/YishuTestbed");
  copyFileSync(testbedBinary, appBinary);
  chmodSync(appBinary, 0o755);
  copyFileSync(path.join(ROOT, "apps/yishu-testbed/Info.plist"), path.join(appDir, "Info.plist"));
  return { appBinary, driver };
}

function killFixture(): void {
  spawnSync("pkill", ["-f", "YishuTestbed.app/Contents/MacOS/YishuTestbed"], { encoding: "utf8" });
  spawnSync("pkill", ["-f", `${BUNDLE_ID}`], { encoding: "utf8" });
}

function launchFixture(appBinary: string, fixture: string): ChildProcess {
  killFixture();
  const child = spawn(appBinary, [], {
    cwd: ROOT,
    env: { ...process.env, YISHU_TESTBED_FIXTURE: fixture },
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  return child;
}

function waitForWindow(driver: string, timeoutMs = 8_000): DriverPayload {
  const started = Date.now();
  let last: DriverPayload = { ok: false, reason: "testbed_window_not_found" };
  while (Date.now() - started < timeoutMs) {
    last = runDriver(driver, ["read", "--identifier", EFFECT_ID]);
    if (last.axTrusted === false) return last;
    if (last.ok) return last;
    spawnSync("sleep", ["0.2"]);
  }
  return last;
}

function runDriver(driver: string, args: string[]): DriverPayload {
  const result = spawnSync(driver, args, { cwd: ROOT, encoding: "utf8" });
  const line = (result.stdout || "").trim().split("\n").at(-1) || "{}";
  try {
    return JSON.parse(line) as DriverPayload;
  } catch {
    return {
      ok: false,
      axTrusted: result.status !== 2,
      reason: result.status === 2 ? "accessibility_tcc_denied" : `driver_exit_${result.status}`,
    };
  }
}

function pollEffect(
  driver: string,
  expected: string,
  timeoutMs: number,
): { value: string | undefined; sawPending: boolean } {
  const started = Date.now();
  let sawPending = false;
  let value: string | undefined;
  while (Date.now() - started < timeoutMs) {
    const read = runDriver(driver, ["read", "--identifier", EFFECT_ID]);
    value = typeof read.value === "string" ? read.value : undefined;
    if (value === "pending") sawPending = true;
    if (value === expected) return { value, sawPending };
    spawnSync("sleep", ["0.25"]);
  }
  return { value, sawPending };
}

async function runScenario(
  driver: string,
  appBinary: string,
  scenario: { id: string; fixture: string; expectedTerminal: string },
): Promise<ScenarioResult> {
  const child = launchFixture(appBinary, scenario.fixture);
  try {
    const ready = waitForWindow(driver);
    if (ready.axTrusted === false) {
      return {
        id: scenario.id,
        app: "yishu-testbed",
        fixture: scenario.fixture,
        evidenceKind: "outside-process-ax-denied",
        passed: false,
        falseCompletionCount: 0,
        reason: "Accessibility TCC denied for the e2e driver; fail closed (not a fake pass).",
      };
    }
    if (!ready.ok) {
      return {
        id: scenario.id,
        app: "yishu-testbed",
        fixture: scenario.fixture,
        evidenceKind: "outside-process-ax",
        passed: false,
        falseCompletionCount: 0,
        reason: ready.reason ?? "Testbed window was not found from outside the process.",
      };
    }

    if (scenario.id.includes("five-step")) {
      for (let step = 1; step <= 5; step += 1) {
        runDriver(driver, ["press", "--identifier", "testbed-primary"]);
        const { value } = pollEffect(driver, `effect-${step}`, 3_000);
        if (value !== `effect-${step}`) {
          return {
            id: scenario.id,
            app: "yishu-testbed",
            fixture: scenario.fixture,
            evidenceKind: "outside-process-ax",
            passed: false,
            falseCompletionCount: 0,
            reason: `step ${step} expected effect-${step} from outside-process AX, got ${value ?? "missing"}`,
            ...(value ? { effect: value } : {}),
          };
        }
      }
      return {
        id: scenario.id,
        app: "yishu-testbed",
        fixture: scenario.fixture,
        evidenceKind: "outside-process-ax",
        passed: true,
        falseCompletionCount: 0,
        reason: "Five outside-process clicks each re-read testbed-effect.",
        effect: "effect-5",
      };
    }

    if (scenario.id.includes("text-field")) {
      const typed = runDriver(driver, ["set-text", "--identifier", "testbed-text", "--text", "hello"]);
      if (!typed.ok) {
        return {
          id: scenario.id,
          app: "yishu-testbed",
          fixture: scenario.fixture,
          evidenceKind: "outside-process-ax",
          passed: false,
          falseCompletionCount: 0,
          reason: typed.reason ?? "outside-process set-text on testbed-text failed",
        };
      }
      runDriver(driver, ["press", "--identifier", "testbed-submit"]);
      const { value } = pollEffect(driver, "effect-1", 3_000);
      const passed = value === "effect-1";
      return {
        id: scenario.id,
        app: "yishu-testbed",
        fixture: scenario.fixture,
        evidenceKind: "outside-process-ax",
        passed,
        falseCompletionCount: 0,
        reason: passed
          ? "Typed then submitted from outside the Testbed process; testbed-effect=effect-1."
          : `text-field expected effect-1, got ${value ?? "missing"}`,
        ...(value ? { effect: value } : {}),
      };
    }

    const before = runDriver(driver, ["read", "--identifier", EFFECT_ID]);
    runDriver(driver, ["press", "--identifier", "testbed-primary"]);
    if (scenario.id.includes("delayed")) {
      const first = runDriver(driver, ["read", "--identifier", EFFECT_ID]);
      const firstValue = typeof first.value === "string" ? first.value : "";
      let falseCompletionCount = 0;
      if (firstValue === "pending" || firstValue === "idle" || firstValue === (before.value ?? "idle")) {
        // Completing on pending/idle would be a false completion; we keep waiting.
      }
      const { value, sawPending } = pollEffect(driver, "effect-1", 5_000);
      if (value !== "effect-1") {
        return {
          id: scenario.id,
          app: "yishu-testbed",
          fixture: scenario.fixture,
          evidenceKind: "outside-process-ax",
          passed: false,
          falseCompletionCount: firstValue === "pending" ? 0 : falseCompletionCount,
          reason: `delayed fixture never reached effect-1 (last=${value ?? "missing"})`,
          ...(value ? { effect: value } : {}),
        };
      }
      return {
        id: scenario.id,
        app: "yishu-testbed",
        fixture: scenario.fixture,
        evidenceKind: "outside-process-ax",
        passed: true,
        falseCompletionCount: 0,
        reason: sawPending
          ? "Ignored pending; outside-process AX read testbed-effect=effect-1 after delay."
          : "Outside-process AX read testbed-effect=effect-1 after delayed click.",
        effect: "effect-1",
      };
    }

    const { value } = pollEffect(
      driver,
      scenario.expectedTerminal === "unknown" ? "idle" : "effect-1",
      3_000,
    );
    if (scenario.expectedTerminal === "unknown") {
      const claimedComplete = value === "effect-1";
      return {
        id: scenario.id,
        app: "yishu-testbed",
        fixture: scenario.fixture,
        evidenceKind: "outside-process-ax",
        passed: value === "idle" && !claimedComplete,
        falseCompletionCount: claimedComplete ? 1 : 0,
        reason: claimedComplete
          ? "unknown-commit was spoken as complete; testbed-effect changed."
          : "unknown-commit left testbed-effect=idle; not treated as complete.",
        ...(value ? { effect: value } : {}),
      };
    }
    const passed = value === "effect-1";
    return {
      id: scenario.id,
      app: "yishu-testbed",
      fixture: scenario.fixture,
      evidenceKind: "outside-process-ax",
      passed,
      falseCompletionCount: 0,
      reason: passed
        ? "Outside-process AX click on Primary; testbed-effect=effect-1."
        : `expected testbed-effect=effect-1 from outside process, got ${value ?? "missing"}`,
      ...(value ? { effect: value } : {}),
    };
  } finally {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    killFixture();
  }
}

export async function runMacosDesktopE2e(): Promise<number> {
  mkdirSync(REPORTS, { recursive: true });
  const unit = spawnSync("swift", ["test", "--package-path", "apps/yishu-testbed"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const unitPassed = unit.status === 0;
  let results: ScenarioResult[] = [];
  let axDenied = false;
  try {
    const { appBinary, driver } = buildTestbed();
    for (const scenario of parseScenarios()) {
      const result = await runScenario(driver, appBinary, scenario);
      results.push(result);
      if (result.evidenceKind === "outside-process-ax-denied") axDenied = true;
    }
  } catch (error) {
    results = parseScenarios().map((scenario) => ({
      id: scenario.id,
      app: "yishu-testbed",
      fixture: scenario.fixture,
      evidenceKind: "outside-process-ax" as const,
      passed: false,
      falseCompletionCount: 0,
      reason: error instanceof Error ? error.message : String(error),
    }));
  }

  const falseCompletionCount = results.reduce((sum, item) => sum + item.falseCompletionCount, 0);
  const failed = results.filter((item) => !item.passed).map((item) => item.id);
  const report = {
    generatedAt: new Date().toISOString(),
    testbedUnitStatus: unit.status,
    testbedUnitPassed: unitPassed,
    axDenied,
    falseCompletionCount,
    failed,
    results,
    note: "User-visible pass requires outside-process AX read of testbed-effect. In-process FixtureTests.performPrimaryAction is not that pass.",
  };
  writeFileSync(path.join(REPORTS, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (!unitPassed) {
    console.error(unit.stdout);
    console.error(unit.stderr);
  }
  if (falseCompletionCount !== 0 || failed.length > 0 || !unitPassed) {
    console.error(`macos e2e failed: ${failed.join(", ") || "testbed-unit"}`);
    if (axDenied) {
      console.error("Accessibility TCC denied; production wiring landed, e2e failed closed.");
    }
    return 1;
  }
  console.log(`macos e2e: ${results.length} outside-process scenarios, false_completion_count=0`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runMacosDesktopE2e().then((code) => process.exit(code));
}
