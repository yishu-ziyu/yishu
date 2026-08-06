import { randomUUID } from "node:crypto";
import type { Diagnosis, EvolutionCandidate } from "./types.js";

/**
 * Propose a minimal candidate update.
 * Offline path: deterministic instruction patch from diagnosis
 * (Penguin REFLECT role — here rule-based so demos need no API).
 *
 * A real-LLM reflect can replace this later without changing the loop.
 */
export function proposeCandidate(options: {
  diagnosis: Diagnosis;
  nextVersion: number;
  /** Optional failed report text for reflect-style proposals */
  failedArtifact?: string;
  referenceArtifact?: string;
}): EvolutionCandidate {
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  if (options.diagnosis.carrier === "instruction") {
    // Infer convention from reference when provided; else use house default.
    const fromReference = options.referenceArtifact ?? "";
    const marker =
      fromReference.match(/^<!--\s*([^>]+)-->/)?.[0]?.trim() ??
      "<!-- YISHU-REPORT -->";
    // Always promote Yishu house rules for this product (not copy Borealis content)
    const content = `# Team report instructions (self-authored candidate)

When writing summary.md or any formal report:

1. Line 1 MUST be exactly: \`<!-- YISHU-REPORT -->\`
2. Line 2 MUST be: \`# Report: <Subject>\` (include the real project name, e.g. Aurora)
3. Include a metadata line: \`Classification: INTERNAL\`
4. Body: short overview + exactly 3 bullet facts grounded in source notes
5. Final non-empty line MUST be: \`Reviewed-by: Yishu Team\`

Do not invent figures. Prefer notes.txt evidence.
Marker template seen in reflections: ${marker}
`;

    return {
      id,
      version: options.nextVersion,
      carrier: "instruction",
      summary: "Add durable team report convention to identity/INSTRUCTIONS.md",
      files: [{ path: "identity/INSTRUCTIONS.md", content }],
      sourceDiagnosis: options.diagnosis,
      createdAt,
    };
  }

  if (options.diagnosis.carrier === "skill") {
    const body = `---
name: report-format
description: Formal report layout for Yishu team
---

# Report format skill

1. Write marker <!-- YISHU-REPORT -->
2. Title # Report: <Subject>
3. Classification: INTERNAL
4. Exactly 3 bullets with evidence
5. Footer Reviewed-by: Yishu Team
`;
    return {
      id,
      version: options.nextVersion,
      carrier: "skill",
      summary: "Add report-format skill",
      files: [{ path: "skills/report-format/SKILL.md", content: body }],
      sourceDiagnosis: options.diagnosis,
      createdAt,
    };
  }

  // knowledge / program fallbacks → still write a short lesson file
  const lesson = `# Experience note

Root cause: ${options.diagnosis.rootCause}

Lessons:
${options.diagnosis.lessons.map((l) => `- ${l}`).join("\n")}
`;
  return {
    id,
    version: options.nextVersion,
    carrier: options.diagnosis.carrier,
    summary: `Record diagnosis as knowledge (${options.diagnosis.carrier})`,
    files: [
      {
        path: `knowledge/${options.diagnosis.taskFamily}.md`,
        content: lesson,
      },
    ],
    sourceDiagnosis: options.diagnosis,
    createdAt,
  };
}

/** Apply candidate files under stateDir. */
export async function applyCandidate(
  stateDir: string,
  candidate: EvolutionCandidate,
  writeFile: (p: string, c: string) => Promise<void>,
  mkdir: (p: string) => Promise<void>,
): Promise<void> {
  const pathMod = await import("node:path");
  for (const f of candidate.files) {
    const abs = pathMod.join(stateDir, f.path);
    await mkdir(pathMod.dirname(abs));
    await writeFile(abs, f.content);
  }
}
