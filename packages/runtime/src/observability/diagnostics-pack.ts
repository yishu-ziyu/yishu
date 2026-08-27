import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { computeQualityMetrics } from "./quality-metrics.js";
import { textLooksLikeSecret } from "./quality-redaction.js";
import type { QualityEvent } from "./quality-event.js";

export interface DiagnosticsPackInput {
  appVersion: string;
  runtimeVersion: string;
  osVersion: string;
  arch: string;
  events: readonly QualityEvent[];
  permissionFlags: Record<string, boolean>;
  schemaMigration?: string;
  scenarioId?: string;
}

export interface DiagnosticsPackManifest {
  createdAt: string;
  files: string[];
  blocked: boolean;
  blockReason?: string;
}

const PACK_FILE_NAMES = ["versions.json", "events.json", "permissions.json", "timeline.json", "metrics.json"] as const;

export function buildDiagnosticsPackContents(input: DiagnosticsPackInput): {
  files: Record<string, string>;
  blocked: boolean;
  blockReason?: string;
} {
  const versions = JSON.stringify({
    appVersion: input.appVersion,
    runtimeVersion: input.runtimeVersion,
    osVersion: input.osVersion,
    arch: input.arch,
    ...(input.schemaMigration === undefined ? {} : { schemaMigration: input.schemaMigration }),
    ...(input.scenarioId === undefined ? {} : { scenarioId: input.scenarioId }),
  }, null, 2);
  const events = JSON.stringify(input.events, null, 2);
  const permissions = JSON.stringify(input.permissionFlags, null, 2);
  const timeline = JSON.stringify(input.events.map((event) => ({
    eventId: event.eventId,
    name: event.name,
    occurredAt: event.occurredAt,
    status: event.status ?? null,
    durationMs: event.durationMs ?? null,
    requestId: event.requestId ?? null,
    traceId: event.traceId ?? null,
    spanId: event.spanId ?? null,
  })), null, 2);
  const metrics = JSON.stringify(computeQualityMetrics(input.events), null, 2);
  const files = {
    "versions.json": versions,
    "events.json": events,
    "permissions.json": permissions,
    "timeline.json": timeline,
    "metrics.json": metrics,
  };
  const joined = Object.values(files).join("\n");
  if (textLooksLikeSecret(joined)) {
    return { files, blocked: true, blockReason: "Diagnostics pack contains credential-like content." };
  }
  return { files, blocked: false };
}

export async function writeDiagnosticsPack(
  directory: string,
  input: DiagnosticsPackInput,
  now = () => new Date(),
): Promise<DiagnosticsPackManifest> {
  const built = buildDiagnosticsPackContents(input);
  if (built.blocked) {
    return {
      createdAt: now().toISOString(),
      files: [],
      blocked: true,
      ...(built.blockReason === undefined ? {} : { blockReason: built.blockReason }),
    };
  }
  await mkdir(directory, { recursive: true });
  for (const [name, body] of Object.entries(built.files)) {
    await writeFile(path.join(directory, name), `${body}\n`, "utf8");
  }
  const manifest: DiagnosticsPackManifest = {
    createdAt: now().toISOString(),
    files: [...PACK_FILE_NAMES],
    blocked: false,
  };
  await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}
