export type {
  MessageRole,
  ChatMessage,
  ToolCategory,
  JsonSchemaLike,
  ToolResult,
  ToolDefinition,
  ToolCallRequest,
  TrajectoryStepKind,
  TrajectoryStep,
  TrajectoryStatus,
  Trajectory,
  AgentConfig,
  Skill,
} from "./types.js";
export { DEFAULT_AGENT_CONFIG } from "./types.js";

export type { LlmPort, LlmResponse } from "./llm.js";
export { DeterministicLlm, resetLlmSeq } from "./llm.js";
export {
  OpenAiCompatibleLlm,
  createLlmFromEnv,
  createOpenAiFromEnv,
  shouldUseOpenAiFromEnv,
  type OpenAiCompatibleLlmOptions,
  type EnvLike,
} from "./llm-openai.js";

export { ToolRegistry } from "./tools/registry.js";
export {
  createBuiltinTools,
  resolveWorkspacePath,
  evalArithmetic,
  type BuiltinToolsOptions,
} from "./tools/builtin.js";
export {
  buildCatalog,
  selectToolsForTask,
  formatCatalogForPrompt,
  createDiscoverToolsTool,
  type ToolCatalogEntry,
} from "./tools/discovery.js";
export {
  loadMcpConfig,
  loadMcpConfigsFromDir,
  mcpSlug,
  mcpToolName,
  mcpToolsToDefinitions,
  parseMcpServerConfig,
  registerMcpServer,
  registerMcpDir,
  type McpToolDescriptor,
  type McpToolHandler,
  type McpServerConfig,
} from "./tools/mcp-adapter.js";

export {
  applyTemplate,
  buildDynamicTool,
  createCreateToolTool,
  DynamicToolStore,
  isDynamicToolKind,
  loadAndRegisterDynamicTools,
  registerDynamicTool,
  validateDynamicToolName,
  DYNAMIC_TOOL_NAME_RE,
  type DynamicToolDef,
  type DynamicToolKind,
  type CreateToolToolOptions,
} from "./tools/dynamic.js";

export {
  FileMemoryStore,
  effectiveLayer,
  isMemoryLayer,
  type MemoryCard,
  type MemoryLayer,
  type MemorySearchOptions,
  type MemoryStore,
} from "./memory/store.js";

export {
  FileKnowledgeStore,
  DEFAULT_KNOWLEDGE_SEEDS,
  type KnowledgeDoc,
  type KnowledgeSearchHit,
  type KnowledgeIngestInput,
} from "./knowledge/store.js";

export { buildStatusBar, type StatusBarInput } from "./context/status-bar.js";
export { compressMessages } from "./context/compress.js";
export {
  loadSkills,
  matchSkills,
  formatSkillsForPrompt,
  type MatchedSkills,
} from "./context/skills.js";

export { TrajectoryRecorder } from "./trajectory/recorder.js";
export {
  verifyTrajectory,
  type TrajectoryVerifyResult,
} from "./trajectory/verifier.js";

export {
  EventBus,
  type AgentEvent,
  type EventPriority,
  type EventHandler,
} from "./events/bus.js";

export {
  AsyncAgent,
  type AsyncAgentOptions,
  type AsyncRunSummary,
  type HeartbeatStatus,
} from "./events/async-agent.js";

export {
  extractLearningSignal,
  appendExperience,
  loadExperiences,
  type LearningSignal,
  type LearningOutcome,
} from "./evolution/learning-signal.js";

export {
  draftSkillFromTrajectory,
  writeSkillDraft,
  type SkillDraft,
  type WriteSkillDraftOptions,
} from "./evolution/skill-draft.js";

export {
  runSelfEvolveRound,
  type SelfEvolveOptions,
} from "./evolution/loop.js";
export { decideGate } from "./evolution/gate.js";
export {
  evaluateEvolutionSuite,
  scoreReport,
  EVOLUTION_CASES,
} from "./evolution/benchmark.js";
export { diagnoseFromEval } from "./evolution/diagnose.js";
export { proposeCandidate } from "./evolution/propose.js";
export { createSnapshot, restoreSnapshot } from "./evolution/snapshot.js";
export { appendScoreboard, loadScoreboard } from "./evolution/scoreboard.js";
export type {
  UpdateCarrier,
  GateDecision,
  EvalMatrix,
  Diagnosis,
  EvolutionCandidate,
  EvolutionRoundReport,
  GateResult,
  ScoreboardEntry,
} from "./evolution/types.js";

export {
  runReactAgent,
  type ReactRunInput,
  type ReactRunResult,
} from "./loop/react.js";
export {
  reviewProposal,
  runWithReviewer,
  type ReviewVerdict,
  type ReviewRound,
  type ReviewerResult,
} from "./loop/verify.js";

export {
  ManagerOrchestrator,
  decomposeTask,
  type SpecialistRole,
  type SubTask,
  type MultiResult,
} from "./multi/orchestrator.js";

export {
  runPeerReviewLoop,
  type PeerReviewOptions,
  type PeerRound,
  type PeerReviewResult,
} from "./multi/peer-review.js";

export {
  runStagedRoles,
  swapSystemPrompt,
  type StageRole,
  type StagedRolesOptions,
  type StageResult,
  type StagedRolesResult,
} from "./multi/staged-roles.js";

export {
  runEval,
  builtinEvalCases,
  type EvalCase,
  type EvalReport,
  type EvalAgentResult,
  type AgentFactory,
} from "./eval/harness.js";

export {
  binomialWilsonInterval,
  comparePassRates,
  formatWilsonCi,
  type WilsonInterval,
  type PassRateSample,
  type PassRateComparison,
} from "./eval/stats.js";

export {
  heuristicJudge,
  llmJudge,
  runEvalWithJudge,
  DEFAULT_JUDGE_RUBRIC,
  type JudgeRubric,
  type JudgeVerdict,
  type JudgeableResult,
  type CaseJudgment,
  type EvalReportWithJudgments,
  type RunEvalWithJudgeOptions,
} from "./eval/judge.js";

export {
  bootstrapMean,
  pairedBootstrapDiff,
  formatBootstrapMean,
  mulberry32,
  type BootstrapMeanResult,
  type PairedBootstrapResult,
  type BootstrapOptions,
} from "./eval/significance.js";

export {
  YishuAgent,
  defaultPaths,
  type YishuAgentOptions,
  type AgentRunResult,
} from "./harness.js";

export {
  scanForInjection,
  wrapUntrustedContent,
  highRiskReminder,
  type InjectionRisk,
  type InjectionScanResult,
} from "./security/injection-guard.js";
