export interface StatusBarInput {
  now: string | Date;
  iteration: number;
  maxIterations: number;
  toolsUsed: string[];
  memoryHits: number;
  workspace: string;
}

/** Compact ephemeral status injected each ReAct iteration. */
export function buildStatusBar(input: StatusBarInput): string {
  const now =
    typeof input.now === "string"
      ? input.now
      : input.now.toISOString();
  const tools =
    input.toolsUsed.length > 0
      ? input.toolsUsed.join(",")
      : "none";
  return [
    "[status]",
    `now=${now}`,
    `iter=${input.iteration}/${input.maxIterations}`,
    `tools=${tools}`,
    `memory_hits=${input.memoryHits}`,
    `workspace=${input.workspace}`,
  ].join(" ");
}
