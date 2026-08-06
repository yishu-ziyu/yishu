#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { YishuAgent, defaultPaths } from "./harness.js";
import { EventBus } from "./events/bus.js";
import { AsyncAgent } from "./events/async-agent.js";
import { createLlmFromEnv, type EnvLike } from "./llm-openai.js";
import type { LlmPort } from "./llm.js";
import type { Trajectory, TrajectoryStep } from "./types.js";
import { verifyTrajectory } from "./trajectory/verifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");

/** Parse --llm=openai | --llm openai; remaining args unchanged order for commands. */
function parseCliArgs(argv: string[]): {
  llmFlag: string | undefined;
  rest: string[];
} {
  let llmFlag: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--llm" || a.startsWith("--llm=")) {
      if (a.startsWith("--llm=")) {
        llmFlag = a.slice("--llm=".length).trim() || undefined;
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          llmFlag = next.trim();
          i += 1;
        } else {
          llmFlag = "openai";
        }
      }
      continue;
    }
    rest.push(a);
  }
  return { llmFlag, rest };
}

function resolveLlm(llmFlag: string | undefined): LlmPort {
  const env: EnvLike = { ...process.env };
  const flag = (llmFlag ?? "").trim().toLowerCase();
  if (flag === "mock" || flag === "deterministic") {
    env.YISHU_AGENT_LLM = "mock";
  } else if (flag === "openai") {
    env.YISHU_AGENT_LLM = "openai";
  }
  return createLlmFromEnv(env);
}

function printStep(step: TrajectoryStep): void {
  const t = step.at.slice(11, 19);
  const data = step.data;
  switch (step.kind) {
    case "status":
      console.log(`  · [${t}] status  ${brief(data)}`);
      break;
    case "think":
      console.log(`  · [${t}] think   ${brief(data)}`);
      break;
    case "tool_call": {
      const d = data as { name?: string; arguments?: unknown };
      console.log(
        `  → [${t}] tool    ${d.name}(${JSON.stringify(d.arguments ?? {})})`,
      );
      break;
    }
    case "tool_result": {
      const d = data as { name?: string; ok?: boolean; content?: string };
      const preview = (d.content ?? "").replace(/\s+/g, " ").slice(0, 100);
      console.log(
        `  ← [${t}] result  ${d.name} ok=${d.ok} ${preview}`,
      );
      break;
    }
    case "final":
      console.log(`  ★ [${t}] final   ${brief(data)}`);
      break;
    case "review":
      console.log(`  ✓ [${t}] review  ${brief(data)}`);
      break;
    default:
      console.log(`  · [${t}] ${step.kind} ${brief(data)}`);
  }
}

function brief(data: unknown): string {
  return JSON.stringify(data).slice(0, 160);
}

function createAgent(llm?: LlmPort): YishuAgent {
  const paths = defaultPaths(packageRoot);
  return new YishuAgent({
    workspaceDir: paths.workspaceDir,
    skillsDir: paths.skillsDir,
    memoryPath: paths.memoryPath,
    trajectoriesDir: paths.trajectoriesDir,
    enableReview: true,
    ...(llm ? { llm } : {}),
  });
}

async function ensureWorkspace(): Promise<void> {
  const paths = defaultPaths(packageRoot);
  await fs.mkdir(paths.workspaceDir, { recursive: true });
  await fs.mkdir(paths.dataDir, { recursive: true });
  await fs.mkdir(paths.trajectoriesDir, { recursive: true });
  const keep = path.join(paths.workspaceDir, ".gitkeep");
  try {
    await fs.access(keep);
  } catch {
    await fs.writeFile(keep, "", "utf8");
  }
  // Seed a tiny note so list_dir has content
  const note = path.join(paths.workspaceDir, "hello.txt");
  try {
    await fs.access(note);
  } catch {
    await fs.writeFile(note, "hello from yishu workspace\n", "utf8");
  }
}

async function cmdRun(task: string, llm?: LlmPort): Promise<void> {
  await ensureWorkspace();
  const agent = createAgent(llm);
  console.log(`\n奕枢 · run\n任务: ${task}\n`);
  const result = await agent.run(task, printStep);
  console.log(`\n---\n回答: ${result.finalText}`);
  console.log(
    `accepted=${result.accepted} tools=[${result.toolsUsed.join(", ")}] trajectory=${result.trajectory.id}`,
  );
}

async function cmdMulti(task: string, llm?: LlmPort): Promise<void> {
  await ensureWorkspace();
  const agent = createAgent(llm);
  console.log(`\n奕枢 · multi\n任务: ${task}\n`);
  const result = await agent.multi(task);
  console.log("子任务:");
  for (const st of result.subtasks) {
    console.log(`  - ${st.id} (${st.role}): ${st.prompt.slice(0, 60)}`);
  }
  console.log("交接:");
  for (const h of result.handoffs) {
    console.log(`  - ${h.from} -> ${h.to}: ${h.summary.slice(0, 80)}`);
  }
  console.log(`\n---\n${result.finalText}`);
  console.log(`trajectory=${result.trajectory.id}`);
}

async function cmdPeer(task: string, llm?: LlmPort): Promise<void> {
  await ensureWorkspace();
  const agent = createAgent(llm);
  console.log(`\n奕枢 · peer (proposer-critic)\n任务: ${task}\n`);
  const result = await agent.peer(task);
  for (const r of result.rounds) {
    const mark = r.accepted ? "ACCEPT" : "REVISE";
    console.log(
      `  round ${r.round} [${mark}] tools=[${r.proposerTools.join(",")}]`,
    );
    console.log(`    proposal: ${r.proposal.slice(0, 100)}`);
    console.log(`    critique: ${r.critique.slice(0, 120)}`);
  }
  console.log(`\n---\n${result.finalText}`);
  console.log(
    `accepted=${result.accepted} rounds=${result.rounds.length} trajectory=${result.trajectory.id}`,
  );
}

async function cmdStaged(task: string, llm?: LlmPort): Promise<void> {
  await ensureWorkspace();
  const agent = createAgent(llm);
  console.log(`\n奕枢 · staged (planner→worker→checker)\n任务: ${task}\n`);
  const result = await agent.staged(task);
  for (const s of result.stages) {
    console.log(
      `  [${s.role}] tools=[${s.toolsUsed.join(",")}] ${s.text.slice(0, 100)}`,
    );
  }
  console.log(`\n---\n${result.finalText}`);
  console.log(
    `stages=${result.stages.length} msgs=${result.messages.length} trajectory=${result.trajectory.id}`,
  );
}

async function cmdEval(llm?: LlmPort): Promise<void> {
  await ensureWorkspace();
  const agent = createAgent(llm);
  const { formatWilsonCi } = await import("./eval/stats.js");
  console.log("\n奕枢 · eval\n");
  const report = await agent.eval();
  for (const c of report.cases) {
    const mark = c.pass ? "PASS" : "FAIL";
    console.log(
      `  [${mark}] ${c.id} tools=[${c.toolsUsed.join(",")}] ${c.finalText.slice(0, 60)}`,
    );
  }
  console.log(
    `\npass rate: ${(report.passRate * 100).toFixed(1)}% (${report.passed}/${report.total})`,
  );
  console.log(`Wilson CI: ${formatWilsonCi(report.passed, report.total)}`);
}

/** Book Ch6: gold eval + offline heuristic (or llm) judge scores per case. */
async function cmdJudgeEval(
  llm?: LlmPort,
  judgeMode: "heuristic" | "llm" = "heuristic",
): Promise<void> {
  await ensureWorkspace();
  const { builtinEvalCases } = await import("./eval/harness.js");
  const { runEvalWithJudge } = await import("./eval/judge.js");
  const paths = defaultPaths(packageRoot);

  console.log(`\n奕枢 · judge-eval (judge=${judgeMode})\n`);

  const report = await runEvalWithJudge(
    builtinEvalCases(),
    () => ({
      run: async (task: string) => {
        const agent = new YishuAgent({
          workspaceDir: paths.workspaceDir,
          skillsDir: paths.skillsDir,
          memoryPath: paths.memoryPath,
          trajectoriesDir: paths.trajectoriesDir,
          enableReview: false,
          enableAutoSkillDraft: false,
          ...(llm ? { llm } : {}),
        });
        await agent.init();
        const r = await agent.run(task);
        return {
          finalText: r.finalText,
          toolsUsed: r.toolsUsed,
          trajectory: r.trajectory,
          accepted: r.accepted,
        };
      },
    }),
    {
      judge: judgeMode,
      ...(judgeMode === "llm" && llm ? { llm } : {}),
    },
  );

  for (const c of report.cases) {
    const j = report.judgments.find((x) => x.id === c.id);
    const gold = c.pass ? "GOLD-PASS" : "GOLD-FAIL";
    const js = j
      ? `judge=${j.verdict.score.toFixed(2)} ${j.verdict.pass ? "PASS" : "FAIL"} (${j.verdict.method})`
      : "judge=?";
    console.log(
      `  [${gold}] ${c.id} tools=[${c.toolsUsed.join(",")}] ${js}`,
    );
    if (j) {
      for (const reason of j.verdict.reasons.slice(0, 3)) {
        console.log(`           · ${reason}`);
      }
    }
  }
  const { formatWilsonCi } = await import("./eval/stats.js");
  console.log(
    `\ngold pass rate: ${(report.passRate * 100).toFixed(1)}% (${report.passed}/${report.total})`,
  );
  console.log(
    `gold Wilson CI: ${formatWilsonCi(report.passed, report.total)}`,
  );
  const judgePass = report.judgments.filter((j) => j.verdict.pass).length;
  const judgeTotal = report.judgments.length;
  console.log(
    `judge pass rate: ${judgeTotal === 0 ? 0 : ((judgePass / judgeTotal) * 100).toFixed(1)}% (${judgePass}/${judgeTotal})`,
  );
  if (judgeTotal > 0) {
    console.log(
      `judge Wilson CI: ${formatWilsonCi(judgePass, judgeTotal)}`,
    );
    const { bootstrapMean, formatBootstrapMean } = await import(
      "./eval/significance.js"
    );
    const scores = report.judgments.map((j) => j.verdict.score);
    const boot = bootstrapMean(scores, { samples: 1000, seed: 42 });
    console.log(`judge scores ${formatBootstrapMean(boot)}`);
  }
}

async function cmdDemo(llm?: LlmPort): Promise<void> {
  await ensureWorkspace();
  console.log("\n奕枢 · demo (offline deterministic)\n");
  await cmdRun("计算 17*19+3", llm);
  await cmdRun("记住：我偏好 tokyonight 主题", llm);
  await cmdRun("列目录 .", llm);
  await cmdRun("搜索 agent memory", llm);
  await cmdRun("关于 ReAct 模式", llm); // knowledge_search
  await cmdMcpList(); // offline MCP tools from data/mcp/
  await cmdMulti("搜索 react agent 并计算 10+5", llm);
}

/**
 * Book ch4 event-driven demo:
 * bus + AsyncAgent → emit user.message → drain → print → exit.
 */
async function cmdServeEvents(llm?: LlmPort): Promise<void> {
  await ensureWorkspace();
  const agent = createAgent(llm);
  const bus = new EventBus();
  const loop = new AsyncAgent({ agent, bus });
  loop.start();

  console.log("\n奕枢 · serve-events (event-driven demo)\n");
  const task = "计算 2+3";
  console.log(`emit user.message: ${task}`);
  bus.emit("user.message", { text: task }, "normal");
  const n = await bus.drain();
  console.log(`drained events: ${n}`);

  const last = loop.lastResult;
  if (!last) {
    console.error("no result collected");
    loop.stop();
    process.exit(1);
  }
  console.log(`\n---\n回答: ${last.finalText}`);
  console.log(
    `accepted=${last.accepted} tools=[${last.toolsUsed.join(", ")}] trajectory=${last.trajectoryId}`,
  );
  loop.stop();
}

/**
 * AsyncAgent heartbeat polish (offline deterministic):
 * start → timer.tick heartbeat → 2 user messages → drain → print.
 */
async function cmdHeartbeatDemo(llm?: LlmPort): Promise<void> {
  await ensureWorkspace();
  const agent = createAgent(llm);
  const bus = new EventBus();
  const loop = new AsyncAgent({ agent, bus });
  loop.start();

  console.log("\n奕枢 · heartbeat-demo (AsyncAgent + timer.tick)\n");

  console.log("emit timer.tick (heartbeat, no LLM)");
  await loop.handle("timer.tick", { n: 1, source: "heartbeat-demo" }, "low");
  console.log(`heartbeats: ${loop.heartbeats.length}`);
  if (loop.heartbeats.length > 0) {
    const hb = loop.heartbeats[loop.heartbeats.length - 1]!;
    console.log(
      `  last heartbeat: eventId=${hb.eventId} resultsCount=${hb.resultsCount} pending=${hb.pending}`,
    );
  }

  const tasks = ["计算 2+3", "计算 10+5"];
  for (const task of tasks) {
    console.log(`emit user.message: ${task}`);
    await loop.handle("user.message", { text: task }, "normal");
  }

  console.log(`\nresults: ${loop.results.length}`);
  for (const r of loop.results) {
    console.log(
      `  - [${r.eventType}] ${r.task} → ${r.finalText.slice(0, 80)} tools=[${r.toolsUsed.join(",")}] accepted=${r.accepted}`,
    );
  }

  const last = loop.lastResult;
  if (!last) {
    console.error("no run results collected");
    loop.stop();
    process.exit(1);
  }
  console.log(`\n---\nlast 回答: ${last.finalText}`);
  console.log(
    `accepted=${last.accepted} tools=[${last.toolsUsed.join(", ")}] trajectory=${last.trajectoryId}`,
  );
  console.log(
    `heartbeats=${loop.heartbeats.length} results=${loop.results.length}`,
  );
  loop.stop();
}

async function cmdEvolve(): Promise<void> {
  const { runSelfEvolveRound } = await import("./evolution/loop.js");
  const paths = defaultPaths(packageRoot);
  const stateDir = path.join(paths.dataDir, "evolution", "state");
  const snapshotsDir = path.join(paths.dataDir, "evolution", "snapshots");
  const scoreboardPath = path.join(paths.dataDir, "evolution", "scoreboard.json");
  const workRoot = path.join(paths.dataDir, "evolution", "work");

  console.log("\n奕枢 · self-evolve (book ch8 + Penguin gate)\n");
  console.log("loop: RUN/EVAL → SIGNAL → DIAGNOSE → PROPOSE → SNAPSHOT → EVAL → GATE → RECORD\n");

  const report = await runSelfEvolveRound({
    stateDir,
    snapshotsDir,
    scoreboardPath,
    workRoot,
    version: 1,
  });

  console.log(`baseline mean:  ${(report.baseline.mean * 100).toFixed(1)}%`);
  console.log(`candidate mean: ${(report.candidateEval.mean * 100).toFixed(1)}%`);
  console.log(`diagnosis: ${report.diagnosis.rootCause}`);
  console.log(`carrier: ${report.diagnosis.carrier}`);
  console.log(`candidate: ${report.candidate.summary}`);
  console.log(`gate: ${report.gate.decision} — ${report.gate.reason}`);
  console.log(`promoted version: ${report.promotedVersion}`);
  console.log(`scoreboard: ${report.scoreboardPath}`);
  console.log(`snapshot: ${report.snapshot.dir}`);

  if (report.gate.decision !== "promote") {
    process.exitCode = 2;
  }
}

/** List offline MCP tools loaded from data/mcp/*.json */
async function cmdMcpList(): Promise<void> {
  await ensureWorkspace();
  const agent = createAgent();
  await agent.init();
  const mcpDir = agent.mcpConfigDir();
  const names = agent.mcpToolNames;
  console.log(`\n奕枢 · mcp-list\nconfig dir: ${mcpDir}\n`);
  if (names.length === 0) {
    console.log("(no MCP tools registered — add JSON under data/mcp/)");
    return;
  }
  for (const name of names) {
    const tool = agent.tools.get(name);
    console.log(
      `  - ${name} [${tool?.category ?? "?"}] ${tool?.description ?? ""}`,
    );
  }
  console.log(`\ntotal: ${names.length}`);
}

/**
 * Book Ch8 experience replay: print last N learning signals from experience.jsonl.
 * Optional args: --n=10 | --n 10 | trailing number (default 10).
 */
async function cmdExperience(args: string[]): Promise<void> {
  const { loadExperiences } = await import("./evolution/learning-signal.js");
  const paths = defaultPaths(packageRoot);
  const experiencePath = path.join(
    paths.dataDir,
    "evolution",
    "experience.jsonl",
  );

  let n = 10;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a.startsWith("--n=")) {
      const v = Number.parseInt(a.slice("--n=".length), 10);
      if (Number.isFinite(v) && v > 0) n = v;
    } else if (a === "--n" || a === "-n") {
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        const v = Number.parseInt(next, 10);
        if (Number.isFinite(v) && v > 0) n = v;
        i += 1;
      }
    } else if (/^\d+$/.test(a)) {
      const v = Number.parseInt(a, 10);
      if (Number.isFinite(v) && v > 0) n = v;
    }
  }

  console.log(`\n奕枢 · experience (Ch8 replay)\nfile: ${experiencePath}\n`);

  let exists = true;
  try {
    await fs.access(experiencePath);
  } catch {
    exists = false;
  }
  if (!exists) {
    console.log(
      "(no experience.jsonl yet — run agent tasks first; online loop appends learning signals here)",
    );
    return;
  }

  const all = await loadExperiences(experiencePath);
  if (all.length === 0) {
    console.log("(experience.jsonl is empty — no learning signals recorded)");
    return;
  }

  const slice = all.slice(-n);
  console.log(`showing last ${slice.length} of ${all.length} signal(s)\n`);
  for (let i = 0; i < slice.length; i += 1) {
    const s = slice[i]!;
    const idx = all.length - slice.length + i + 1;
    const tools = s.toolsUsed.length > 0 ? s.toolsUsed.join(", ") : "(none)";
    const review =
      s.reviewAccepted === undefined
        ? ""
        : ` reviewAccepted=${s.reviewAccepted}`;
    console.log(`  #${idx} outcome=${s.outcome} tools=[${tools}]${review}`);
    for (const lesson of s.lessons) {
      console.log(`       · ${lesson}`);
    }
  }
}

/** Offline status: paths + counts (no LLM, no tool execution). */
async function cmdStatus(): Promise<void> {
  const paths = defaultPaths(packageRoot);
  let version = "0.0.1";
  try {
    const raw = await fs.readFile(path.join(packageRoot, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    if (typeof pkg.version === "string" && pkg.version.trim()) {
      version = pkg.version.trim();
    }
  } catch {
    // keep default 0.0.1
  }

  const [
    trajectoryCount,
    memoryCount,
    knowledgeCount,
    mcpToolCount,
    skillFolderCount,
  ] = await Promise.all([
    countTrajectoryFiles(paths.trajectoriesDir),
    countMemoryCards(paths.memoryPath),
    countKnowledgeDocs(paths.knowledgeDir),
    countMcpTools(paths.mcpDir),
    countSkillFolders(paths.skillsDir),
  ]);

  console.log("\n奕枢 · status (offline)\n");
  console.log(`package: @yishu/agent-core`);
  console.log(`version: ${version}`);
  console.log("\npaths:");
  console.log(`  workspace:      ${paths.workspaceDir}`);
  console.log(`  skills:         ${paths.skillsDir}`);
  console.log(`  memory:         ${paths.memoryPath}`);
  console.log(`  knowledge:      ${paths.knowledgeDir}`);
  console.log(`  mcp:            ${paths.mcpDir}`);
  console.log(`  skill-drafts:   ${paths.skillDraftsDir}`);
  console.log(`  trajectories:   ${paths.trajectoriesDir}`);
  console.log("\ncounts:");
  console.log(`  trajectories:   ${trajectoryCount}`);
  console.log(`  memory cards:   ${memoryCount}`);
  console.log(`  knowledge docs: ${knowledgeCount}`);
  console.log(`  mcp tools:      ${mcpToolCount}`);
  console.log(`  skills folders: ${skillFolderCount}`);
}

/**
 * Resolve a trajectory path from repo root, package root, or cwd.
 * Handles `packages/agent-core/...` when cwd is already the package.
 */
async function resolveTrajectoryPath(trajPath: string): Promise<string> {
  const candidates = [
    path.resolve(trajPath),
    path.resolve(process.cwd(), trajPath),
    path.resolve(packageRoot, trajPath),
    path.resolve(
      packageRoot,
      trajPath.replace(/^(?:\.\/)?packages\/agent-core\//, ""),
    ),
    path.resolve(packageRoot, "data", "trajectories", path.basename(trajPath)),
  ];
  for (const c of candidates) {
    try {
      await fs.access(c);
      return c;
    } catch {
      // try next
    }
  }
  return path.resolve(process.cwd(), trajPath);
}

/**
 * Offline trajectory replay: pretty-print steps timeline.
 * Does NOT re-execute tools (safe offline).
 */
async function cmdReplay(trajPath: string): Promise<void> {
  const resolved = await resolveTrajectoryPath(trajPath);
  let raw: string;
  try {
    raw = await fs.readFile(resolved, "utf8");
  } catch (err) {
    console.error(`cannot read trajectory: ${resolved}`);
    console.error(err);
    process.exit(1);
  }

  let trajectory: Trajectory;
  try {
    trajectory = JSON.parse(raw) as Trajectory;
  } catch (err) {
    console.error(`invalid trajectory JSON: ${resolved}`);
    console.error(err);
    process.exit(1);
  }

  const steps = Array.isArray(trajectory.steps) ? trajectory.steps : [];
  const toolsUsed: string[] = [];
  for (const step of steps) {
    if (step.kind === "tool_call") {
      const d = step.data as { name?: string };
      if (d?.name && !toolsUsed.includes(d.name)) toolsUsed.push(d.name);
    }
  }

  console.log(`\n奕枢 · replay (offline, no tool re-exec)\nfile: ${resolved}`);
  console.log(`id: ${trajectory.id ?? "(missing)"}`);
  console.log(`task: ${trajectory.task ?? "(missing)"}`);
  console.log(`status: ${trajectory.status ?? "(missing)"}`);
  console.log(`steps: ${steps.length}\n`);

  for (const step of steps) {
    printStep(step);
  }

  console.log("\n---");
  console.log(`final status: ${trajectory.status ?? "(missing)"}`);
  if (trajectory.result !== undefined && trajectory.result !== "") {
    const preview = String(trajectory.result).replace(/\s+/g, " ").slice(0, 200);
    console.log(`result: ${preview}`);
  }
  console.log(
    `tools used: [${toolsUsed.length === 0 ? "" : toolsUsed.join(", ")}]`,
  );
  if (trajectory.endedAt) {
    console.log(`endedAt: ${trajectory.endedAt}`);
  }
}

async function countTrajectoryFiles(dir: string): Promise<number> {
  try {
    const entries = await fs.readdir(dir);
    return entries.filter(
      (name) =>
        name.endsWith(".json") &&
        !name.endsWith(".signal.json") &&
        !name.endsWith(".verify.json") &&
        !name.endsWith(".skill.json"),
    ).length;
  } catch {
    return 0;
  }
}

async function countMemoryCards(memoryPath: string): Promise<number> {
  try {
    const raw = await fs.readFile(memoryPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.length;
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { cards?: unknown }).cards)
    ) {
      return (parsed as { cards: unknown[] }).cards.length;
    }
    return 0;
  } catch {
    return 0;
  }
}

async function countKnowledgeDocs(knowledgeDir: string): Promise<number> {
  try {
    const indexPath = path.join(knowledgeDir, "index.json");
    const raw = await fs.readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.length;
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { docs?: unknown }).docs)
    ) {
      return (parsed as { docs: unknown[] }).docs.length;
    }
    return 0;
  } catch {
    return 0;
  }
}

async function countMcpTools(mcpDir: string): Promise<number> {
  try {
    const { loadMcpConfigsFromDir } = await import("./tools/mcp-adapter.js");
    const configs = await loadMcpConfigsFromDir(mcpDir);
    return configs.reduce((n, c) => n + (c.tools?.length ?? 0), 0);
  } catch {
    return 0;
  }
}

async function countSkillFolders(skillsDir: string): Promise<number> {
  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

async function cmdVerify(trajPath: string): Promise<void> {
  const resolved = await resolveTrajectoryPath(trajPath);
  let raw: string;
  try {
    raw = await fs.readFile(resolved, "utf8");
  } catch (err) {
    console.error(`cannot read trajectory: ${resolved}`);
    console.error(err);
    process.exit(1);
  }
  const trajectory = JSON.parse(raw) as Trajectory;
  const result = verifyTrajectory(trajectory, trajectory.task);
  console.log(`\n奕枢 · verify\nfile: ${resolved}`);
  console.log(`id: ${trajectory.id}`);
  console.log(`task: ${trajectory.task}`);
  console.log(`ok: ${result.ok}  score: ${result.score.toFixed(2)}`);
  if (result.issues.length === 0) {
    console.log("issues: (none)");
  } else {
    console.log("issues:");
    for (const issue of result.issues) {
      console.log(`  - ${issue}`);
    }
  }
  process.exit(result.ok ? 0 : 2);
}

/**
 * Book Ch8: promote a skill draft from a finished trajectory (experience → skill).
 * --dry-run only prints draft body; otherwise writes to skillsDir with accepted=true.
 */
async function cmdPromoteSkill(
  trajPath: string,
  dryRun: boolean,
): Promise<void> {
  const { draftSkillFromTrajectory, writeSkillDraft } = await import(
    "./evolution/skill-draft.js"
  );
  const resolved = await resolveTrajectoryPath(trajPath);
  let raw: string;
  try {
    raw = await fs.readFile(resolved, "utf8");
  } catch (err) {
    console.error(`cannot read trajectory: ${resolved}`);
    console.error(err);
    process.exit(1);
  }
  const trajectory = JSON.parse(raw) as Trajectory;
  const draft = draftSkillFromTrajectory(trajectory);

  console.log(`\n奕枢 · promote-skill\nfile: ${resolved}`);
  console.log(`trajectory: ${trajectory.id}`);
  console.log(`skill name: ${draft.name}`);
  console.log(`description: ${draft.description}`);

  if (dryRun) {
    console.log("\n--- draft body (dry-run, not written) ---\n");
    console.log(draft.body);
    return;
  }

  const paths = defaultPaths(packageRoot);
  await fs.mkdir(paths.skillsDir, { recursive: true });
  const written = await writeSkillDraft(paths.skillsDir, draft, {
    accepted: true,
  });
  if (!written) {
    console.error("writeSkillDraft returned null (unexpected with accepted=true)");
    process.exit(1);
  }
  console.log(`written: ${written}`);
}

function parseJudgeMode(args: string[]): "heuristic" | "llm" {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a.startsWith("--judge=")) {
      const v = a.slice("--judge=".length).trim().toLowerCase();
      return v === "llm" ? "llm" : "heuristic";
    }
    if (a === "--judge") {
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        return next.trim().toLowerCase() === "llm" ? "llm" : "heuristic";
      }
    }
  }
  if (args.includes("llm")) return "llm";
  return "heuristic";
}

function usage(): void {
  console.log(`yishu-agent - offline agent-core CLI

Usage:
  yishu-agent status
  yishu-agent run "task"
  yishu-agent multi "task"
  yishu-agent peer "task"
  yishu-agent staged "task"
  yishu-agent eval
  yishu-agent judge-eval [--judge=heuristic|llm]
  yishu-agent demo
  yishu-agent serve-events
  yishu-agent heartbeat-demo
  yishu-agent evolve
  yishu-agent mcp-list
  yishu-agent experience [--n=10]
  yishu-agent replay <trajectory.json>
  yishu-agent verify <trajectory.json>
  yishu-agent promote-skill <trajectory.json> [--dry-run]

LLM (default: deterministic / mock):
  --llm=openai | --llm openai   use OpenAI-compatible API
  --llm=mock                    force DeterministicLlm
  env: YISHU_AGENT_LLM=openai|mock
       OPENAI_API_KEY | OPENROUTER_API_KEY
       OPENAI_BASE_URL  OPENAI_MODEL
`);
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2).filter((a) => a !== "--");
  const { llmFlag, rest: args } = parseCliArgs(raw);
  const cmd = args[0];

  if (!cmd || cmd === "-h" || cmd === "--help") {
    usage();
    process.exit(cmd ? 0 : 1);
  }

  // Lazy: only construct LLM for commands that need it (verify/help stay offline).
  const needLlm = [
    "run",
    "multi",
    "peer",
    "staged",
    "eval",
    "judge-eval",
    "demo",
    "serve-events",
    "heartbeat-demo",
  ].includes(cmd);
  // evolve is offline-deterministic (no LLM required for the gate demo)
  const llm = needLlm ? resolveLlm(llmFlag) : undefined;

  if (cmd === "run") {
    const task = args.slice(1).join(" ").trim();
    if (!task) {
      console.error("missing task");
      process.exit(1);
    }
    await cmdRun(task, llm);
    return;
  }

  if (cmd === "multi") {
    const task = args.slice(1).join(" ").trim();
    if (!task) {
      console.error("missing task");
      process.exit(1);
    }
    await cmdMulti(task, llm);
    return;
  }

  if (cmd === "peer") {
    const task = args.slice(1).join(" ").trim();
    if (!task) {
      console.error("missing task");
      process.exit(1);
    }
    await cmdPeer(task, llm);
    return;
  }

  if (cmd === "staged") {
    const task = args.slice(1).join(" ").trim();
    if (!task) {
      console.error("missing task");
      process.exit(1);
    }
    await cmdStaged(task, llm);
    return;
  }

  if (cmd === "eval") {
    await cmdEval(llm);
    return;
  }

  if (cmd === "judge-eval") {
    const mode = parseJudgeMode(args.slice(1));
    await cmdJudgeEval(llm, mode);
    return;
  }

  if (cmd === "demo") {
    await cmdDemo(llm);
    return;
  }

  if (cmd === "serve-events") {
    await cmdServeEvents(llm);
    return;
  }

  if (cmd === "heartbeat-demo") {
    await cmdHeartbeatDemo(llm);
    return;
  }

  if (cmd === "evolve") {
    await cmdEvolve();
    return;
  }

  if (cmd === "mcp-list") {
    await cmdMcpList();
    return;
  }

  if (cmd === "status") {
    await cmdStatus();
    return;
  }

  if (cmd === "experience") {
    await cmdExperience(args.slice(1));
    return;
  }

  if (cmd === "replay") {
    const trajPath = args[1]?.trim();
    if (!trajPath) {
      console.error("missing trajectory.json path");
      process.exit(1);
    }
    await cmdReplay(trajPath);
    return;
  }

  if (cmd === "verify") {
    const trajPath = args[1]?.trim();
    if (!trajPath) {
      console.error("missing trajectory.json path");
      process.exit(1);
    }
    await cmdVerify(trajPath);
    return;
  }

  if (cmd === "promote-skill") {
    const rest = args.slice(1);
    const dryRun = rest.includes("--dry-run");
    const trajPath = rest.find((a) => !a.startsWith("-"))?.trim();
    if (!trajPath) {
      console.error("missing trajectory.json path");
      process.exit(1);
    }
    await cmdPromoteSkill(trajPath, dryRun);
    return;
  }

  console.error(`unknown command: ${cmd}`);
  usage();
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
