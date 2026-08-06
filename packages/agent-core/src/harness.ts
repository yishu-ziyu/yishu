import { promises as fs } from "node:fs";
import path from "node:path";
import { DeterministicLlm, type LlmPort } from "./llm.js";
import {
  loadSkills,
  matchSkills,
  formatSkillsForPrompt,
} from "./context/skills.js";
import { FileMemoryStore } from "./memory/store.js";
import { FileKnowledgeStore } from "./knowledge/store.js";
import { createBuiltinTools } from "./tools/builtin.js";
import {
  buildCatalog,
  createDiscoverToolsTool,
  selectToolsForTask,
} from "./tools/discovery.js";
import {
  createCreateToolTool,
  DynamicToolStore,
  loadAndRegisterDynamicTools,
} from "./tools/dynamic.js";
import { registerMcpDir } from "./tools/mcp-adapter.js";
import { ToolRegistry } from "./tools/registry.js";
import { runReactAgent } from "./loop/react.js";
import { runWithReviewer } from "./loop/verify.js";
import { ManagerOrchestrator } from "./multi/orchestrator.js";
import {
  runPeerReviewLoop,
  type PeerReviewResult,
} from "./multi/peer-review.js";
import {
  runStagedRoles,
  type StagedRolesResult,
} from "./multi/staged-roles.js";
import {
  builtinEvalCases,
  runEval,
  type EvalReport,
} from "./eval/harness.js";
import {
  appendExperience,
  extractLearningSignal,
} from "./evolution/learning-signal.js";
import {
  draftSkillFromTrajectory,
  writeSkillDraft,
} from "./evolution/skill-draft.js";
import {
  highRiskReminder,
  scanForInjection,
} from "./security/injection-guard.js";
import { verifyTrajectory } from "./trajectory/verifier.js";
import type {
  AgentConfig,
  ChatMessage,
  Trajectory,
  TrajectoryStep,
} from "./types.js";
import { DEFAULT_AGENT_CONFIG } from "./types.js";

/** Meta-only tools: do not auto-promote when these are the only tools used. */
const META_SKILL_TOOLS = new Set(["discover_tools", "ask_user", "create_tool"]);

export interface YishuAgentOptions {
  workspaceDir: string;
  skillsDir: string;
  memoryPath: string;
  /** Directory for knowledge index.json (default: data/knowledge next to memory). */
  knowledgeDir?: string;
  maxIterations?: number;
  maxReviewRounds?: number;
  enableReview?: boolean;
  /** When true (default), write ${id}.verify.json next to trajectory. */
  enableTrajectoryVerify?: boolean;
  /**
   * Book ch8: after verified successful tool runs, draft a skill under skillsDir.
   * Default true for harness; set false to disable.
   */
  enableAutoSkillDraft?: boolean;
  llm?: LlmPort;
  trajectoriesDir?: string;
}

export interface AgentRunResult {
  finalText: string;
  trajectory: Trajectory;
  toolsUsed: string[];
  accepted: boolean;
  messages: ChatMessage[];
}

export class YishuAgent {
  readonly config: AgentConfig;
  readonly tools: ToolRegistry;
  readonly memory: FileMemoryStore;
  readonly knowledge: FileKnowledgeStore;
  private readonly knowledgeDir: string;
  private readonly llm: LlmPort;
  private readonly trajectoriesDir: string;
  private readonly enableTrajectoryVerify: boolean;
  private readonly enableAutoSkillDraft: boolean;
  private mcpLoaded = false;
  private dynamicLoaded = false;
  /** Registered MCP tool names (populated after init loads data/mcp). */
  mcpToolNames: string[] = [];
  /** Registered dynamic tool names (from data/dynamic-tools.json). */
  dynamicToolNames: string[] = [];
  readonly dynamicStore: DynamicToolStore;

  constructor(options: YishuAgentOptions) {
    this.config = {
      maxIterations: options.maxIterations ?? DEFAULT_AGENT_CONFIG.maxIterations,
      maxReviewRounds:
        options.maxReviewRounds ?? DEFAULT_AGENT_CONFIG.maxReviewRounds,
      workspaceDir: options.workspaceDir,
      skillsDir: options.skillsDir,
      memoryPath: options.memoryPath,
      enableReview: options.enableReview ?? DEFAULT_AGENT_CONFIG.enableReview,
    };
    this.memory = new FileMemoryStore(options.memoryPath);
    // Default knowledge path: data/knowledge/index.json (dir next to memory)
    this.knowledgeDir =
      options.knowledgeDir ??
      path.join(path.dirname(options.memoryPath), "knowledge");
    this.knowledge = new FileKnowledgeStore(this.knowledgeDir);
    this.dynamicStore = new DynamicToolStore(
      path.join(path.dirname(options.memoryPath), "dynamic-tools.json"),
    );
    this.tools = new ToolRegistry();
    const builtins = createBuiltinTools({
      workspaceDir: options.workspaceDir,
      memory: this.memory,
      knowledge: this.knowledge,
    });
    this.tools.registerAll(builtins);
    // Meta tool for on-demand catalog listing (full registry view)
    this.tools.register(
      createDiscoverToolsTool(() => buildCatalog(this.tools.list())),
    );
    // Book ch5: create_tool meta-bootstrap (echo/const/template only)
    this.tools.register(
      createCreateToolTool({
        registry: this.tools,
        store: this.dynamicStore,
      }),
    );
    this.llm = options.llm ?? new DeterministicLlm();
    this.trajectoriesDir =
      options.trajectoriesDir ??
      path.join(path.dirname(options.memoryPath), "trajectories");
    this.enableTrajectoryVerify = options.enableTrajectoryVerify ?? true;
    this.enableAutoSkillDraft = options.enableAutoSkillDraft ?? true;
  }

  /** Directory for offline MCP JSON configs (sibling of memory.json → data/mcp). */
  mcpConfigDir(): string {
    return path.join(path.dirname(this.config.memoryPath), "mcp");
  }

  /** Path for persisted dynamic tools (sibling of memory.json → data/dynamic-tools.json). */
  dynamicToolsPath(): string {
    return this.dynamicStore.path;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.config.workspaceDir, { recursive: true });
    await fs.mkdir(path.dirname(this.config.memoryPath), { recursive: true });
    await fs.mkdir(this.knowledgeDir, { recursive: true });
    await fs.mkdir(this.trajectoriesDir, { recursive: true });
    await this.memory.load();
    await this.knowledge.load();
    // Book ch5: load persisted dynamic tools before MCP so names stay stable
    if (!this.dynamicLoaded) {
      this.dynamicToolNames = await loadAndRegisterDynamicTools(
        this.tools,
        this.dynamicStore,
      );
      this.dynamicLoaded = true;
    }
    // Book ch4: optional offline MCP tool adapters from data/mcp/*.json
    if (!this.mcpLoaded) {
      this.mcpToolNames = await registerMcpDir(this.tools, this.mcpConfigDir());
      this.mcpLoaded = true;
    }
  }

  private async buildSystemPrompt(task: string): Promise<string> {
    const skills = await loadSkills(this.config.skillsDir);
    const matched = matchSkills(task, skills);
    const skillBlock = formatSkillsForPrompt(matched);
    // Promoted durable instructions from self-evolution (book ch8 instruction carrier)
    let evolvedInstructions = "";
    const identityPath = path.join(
      path.dirname(this.config.memoryPath),
      "evolution",
      "state",
      "identity",
      "INSTRUCTIONS.md",
    );
    try {
      const raw = await fs.readFile(identityPath, "utf8");
      if (raw.trim().length > 0) {
        evolvedInstructions = `\n## Evolved instructions (promoted)\n${raw.trim()}\n`;
      }
    } catch {
      // none promoted yet
    }
    return [
      "你是奕枢（Yishu），简洁、有判断力的个人 Agent。",
      "使用工具获取证据后再下结论。不要编造工具结果。",
      "回答简短清楚，跟随用户语言。",
      skillBlock,
      evolvedInstructions,
    ]
      .filter((s) => s.length > 0)
      .join("\n");
  }

  /** Task-scoped registry: keyword subset + always-on ask_user / discover_tools. */
  toolsForTask(task: string): ToolRegistry {
    const all = this.tools.list();
    const catalog = buildCatalog(all);
    const selected = selectToolsForTask(task, catalog, all);
    return this.tools.subset(selected.map((t) => t.name));
  }

  async run(
    task: string,
    onStep?: (step: TrajectoryStep) => void,
  ): Promise<AgentRunResult> {
    await this.init();
    const system = await this.buildSystemPrompt(task);
    const baseMessages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: task },
    ];
    // Light injection defense: high-risk user utterance gets a system reminder.
    const injectionScan = scanForInjection(task);
    if (injectionScan.risk === "high") {
      baseMessages.push({
        role: "system",
        content: highRiskReminder(injectionScan),
      });
    }
    // Active tool discovery: pass only task-relevant schemas into ReAct
    const tools = this.toolsForTask(task);

    if (this.config.enableReview) {
      const reviewed = await runWithReviewer({
        task,
        maxRounds: this.config.maxReviewRounds,
        ...(onStep ? { onStep } : {}),
        proposerRun: async () => {
          const llm =
            this.llm instanceof DeterministicLlm
              ? new DeterministicLlm()
              : this.llm;
          return runReactAgent({
            llm,
            tools,
            messages: baseMessages.map((m) => ({ ...m })),
            config: this.config,
            task,
            ...(onStep ? { onStep } : {}),
          });
        },
      });
      await this.persistTrajectory(reviewed.trajectory);
      return {
        finalText: reviewed.finalText,
        trajectory: reviewed.trajectory,
        toolsUsed: reviewed.toolsUsed,
        accepted: reviewed.accepted,
        messages: [],
      };
    }

    const llm =
      this.llm instanceof DeterministicLlm
        ? new DeterministicLlm()
        : this.llm;
    const result = await runReactAgent({
      llm,
      tools,
      messages: baseMessages,
      config: this.config,
      task,
      ...(onStep ? { onStep } : {}),
    });
    await this.persistTrajectory(result.trajectory);
    return {
      finalText: result.finalText,
      trajectory: result.trajectory,
      toolsUsed: result.toolsUsed,
      accepted: true,
      messages: result.messages,
    };
  }

  async multi(task: string) {
    await this.init();
    const orch = new ManagerOrchestrator({
      tools: this.tools,
      config: this.config,
      llm: this.llm,
    });
    const result = await orch.run(task);
    await this.persistTrajectory(result.trajectory);
    return result;
  }

  /** Book ch10 peer collaboration: proposer + critic isolated contexts. */
  async peer(task: string, rounds?: number): Promise<PeerReviewResult> {
    await this.init();
    const result = await runPeerReviewLoop({
      task,
      tools: this.tools,
      config: this.config,
      llm: this.llm,
      ...(rounds !== undefined ? { rounds } : {}),
    });
    await this.persistTrajectory(result.trajectory);
    return result;
  }

  /** Book ch10 shared-context staged roles: planner -> worker -> checker. */
  async staged(task: string): Promise<StagedRolesResult> {
    await this.init();
    const result = await runStagedRoles({
      task,
      tools: this.tools,
      config: this.config,
      llm: this.llm,
    });
    await this.persistTrajectory(result.trajectory);
    return result;
  }

  async eval(): Promise<EvalReport> {
    await this.init();
    const self = this;
    return runEval(builtinEvalCases(), () => ({
      run: async (task: string) => {
        // Fresh agent per case for isolation of LLM call counts
        const agent = new YishuAgent({
          workspaceDir: self.config.workspaceDir,
          skillsDir: self.config.skillsDir,
          memoryPath: self.config.memoryPath,
          knowledgeDir: self.knowledgeDir,
          maxIterations: self.config.maxIterations,
          maxReviewRounds: self.config.maxReviewRounds,
          enableReview: false,
          trajectoriesDir: self.trajectoriesDir,
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
    }));
  }

  private async persistTrajectory(t: Trajectory): Promise<string> {
    await fs.mkdir(this.trajectoriesDir, { recursive: true });
    const file = path.join(this.trajectoriesDir, `${t.id}.json`);
    await fs.writeFile(file, JSON.stringify(t, null, 2), "utf8");
    // Book ch8: learning signal next to trajectory when dir is configured
    if (this.trajectoriesDir) {
      const signal = extractLearningSignal(t);
      const signalFile = path.join(
        this.trajectoriesDir,
        `${t.id}.signal.json`,
      );
      await fs.writeFile(
        signalFile,
        JSON.stringify(signal, null, 2),
        "utf8",
      );
      // Online half of dual-loop: append experience JSONL (offline evolve consumes later)
      const experiencePath = path.join(
        path.dirname(this.trajectoriesDir),
        "evolution",
        "experience.jsonl",
      );
      await appendExperience(experiencePath, signal);
      // Book ch8: trajectory verification sibling file
      const needsVerify =
        this.enableTrajectoryVerify || this.enableAutoSkillDraft;
      const verification = needsVerify
        ? verifyTrajectory(t, t.task)
        : null;
      if (this.enableTrajectoryVerify && verification) {
        const verifyFile = path.join(
          this.trajectoriesDir,
          `${t.id}.verify.json`,
        );
        await fs.writeFile(
          verifyFile,
          JSON.stringify(verification, null, 2),
          "utf8",
        );
      }

      // Book ch8: gated auto skill promotion from verified successful tool runs
      if (this.enableAutoSkillDraft && verification) {
        await this.maybeAutoDraftSkill(t, verification.ok);
      }
    }
    return file;
  }

  /**
   * Write a skill *draft* (not promoted into live skills/) when trajectory is
   * completed, verified ok, and has at least one non-meta tool_call.
   * Drafts land under data/skill-drafts/; use CLI promote-skill to promote.
   */
  private async maybeAutoDraftSkill(
    t: Trajectory,
    verificationOk: boolean,
  ): Promise<void> {
    if (t.status !== "completed" || !verificationOk) return;

    const toolNames: string[] = [];
    for (const s of t.steps) {
      if (s.kind !== "tool_call") continue;
      const name = (s.data as { name?: string }).name;
      if (name) toolNames.push(name);
    }
    if (toolNames.length === 0) return;

    const productive = toolNames.filter((n) => !META_SKILL_TOOLS.has(n));
    if (productive.length === 0) return;

    const draft = draftSkillFromTrajectory(t);
    // Keep live skills/ clean: auto drafts go to data/skill-drafts only.
    const draftRoot = path.join(
      path.dirname(this.config.memoryPath),
      "skill-drafts",
    );
    const written = await writeSkillDraft(draftRoot, draft, {
      accepted: true,
    });
    if (!written) return;

    const sidecar = {
      path: written,
      name: draft.name,
      auto: true as const,
      promoted: false as const,
    };
    const skillMetaFile = path.join(
      this.trajectoriesDir,
      `${t.id}.skill.json`,
    );
    await fs.writeFile(
      skillMetaFile,
      JSON.stringify(sidecar, null, 2),
      "utf8",
    );
  }
}

export function defaultPaths(packageRoot: string): {
  workspaceDir: string;
  skillsDir: string;
  memoryPath: string;
  knowledgeDir: string;
  trajectoriesDir: string;
  dataDir: string;
  mcpDir: string;
  skillDraftsDir: string;
} {
  const dataDir = path.join(packageRoot, "data");
  return {
    workspaceDir: path.join(packageRoot, "workspace"),
    skillsDir: path.join(packageRoot, "skills"),
    memoryPath: path.join(dataDir, "memory.json"),
    knowledgeDir: path.join(dataDir, "knowledge"),
    trajectoriesDir: path.join(dataDir, "trajectories"),
    dataDir,
    mcpDir: path.join(dataDir, "mcp"),
    skillDraftsDir: path.join(dataDir, "skill-drafts"),
  };
}
