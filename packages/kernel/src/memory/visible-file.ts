/**
 * The one user-visible memory file.
 *
 * Agent judges what to append. The user edits this file. Existing lines are
 * never rewritten. Deleted rows suppress matching derived recall candidates.
 */

import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { assertPersistableMemoryText } from "../store/ledger-safety.js";
import { parseFactLine } from "./truth-layer.js";

export const VISIBLE_MEMORY_FILE_NAME = "记忆.md";

export const VISIBLE_MEMORY_HEADER = `# 记忆

奕枢会把值得记住的事写在这里。
你可以直接改、删、加一行。每条用「- 」开头。改完下次说话就会用。

`;

const FACT_CLAIM_CHARS = 200;
const BULLET = /^\s*[-*]\s+(.*)$/u;
const AUTHORITY_STATE_FILE_NAME = ".yishu-memory-authority.json";
const FINGERPRINT = /^[a-f0-9]{64}$/u;

const pathLocks = new Map<string, Promise<unknown>>();

export function defaultVisibleMemoryPath(): string {
  return path.join(homedir(), "Documents", "Yishu", VISIBLE_MEMORY_FILE_NAME);
}

export function normalizeVisibleFact(text: string): string {
  return text
    .replace(/\s+/gu, " ")
    .replace(/[。.!！？?；;，,、]+$/u, "")
    .trim()
    .toLowerCase();
}

export function visibleFactFingerprint(text: string): string {
  return createHash("sha256").update(normalizeVisibleFact(text), "utf8").digest("hex");
}

const SPEAKER_PREFIX = /^(用户|我)(的)?/u;
const LOCATIVE_PREFIX = /^(现居|住在|居住在|位于|住)/u;
const LIKING_PREFIX = /^(喜欢|爱喝|爱用|偏好|常喝|爱)/u;
const MIN_SEMANTIC_KEY_CHARS = 2;
const MAX_SEMANTIC_KEY_CHARS = 16;

export function semanticSuppressionKeys(text: string): string[] {
  const normalized = normalizeVisibleFact(text).replace(/\s+/gu, "");
  if (normalized.length < MIN_SEMANTIC_KEY_CHARS) return [];
  const keys = new Set<string>();
  const add = (value: string): void => {
    if (value.length < MIN_SEMANTIC_KEY_CHARS) return;
    if (value.length > MAX_SEMANTIC_KEY_CHARS) return;
    keys.add(value);
  };
  const withoutSpeaker = normalized.replace(SPEAKER_PREFIX, "");
  add(withoutSpeaker);
  add(withoutSpeaker.replace(LOCATIVE_PREFIX, ""));
  add(withoutSpeaker.replace(LIKING_PREFIX, ""));
  return [...keys];
}

function semanticKeysOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  for (const a of left) {
    for (const b of right) {
      if (a === b) return true;
      const shorter = a.length <= b.length ? a : b;
      const longer = a.length <= b.length ? b : a;
      if (
        shorter.length >= MIN_SEMANTIC_KEY_CHARS
        && longer.includes(shorter)
        && shorter.length * 2 >= longer.length
      ) {
        return true;
      }
    }
  }
  return false;
}

export function factsSemanticallyMatch(left: string, right: string): boolean {
  return semanticKeysOverlap(semanticSuppressionKeys(left), semanticSuppressionKeys(right));
}

export interface VisibleMemoryAuthoritySnapshot {
  readonly facts: readonly string[];
  readonly suppressedFingerprints: readonly string[];
  readonly suppressedKeys: readonly string[];
}

export function isVisibleFactSuppressed(
  snapshot: VisibleMemoryAuthoritySnapshot,
  claim: string,
): boolean {
  if (snapshot.suppressedFingerprints.includes(visibleFactFingerprint(claim))) {
    return true;
  }
  return semanticKeysOverlap(semanticSuppressionKeys(claim), snapshot.suppressedKeys);
}

export function claimFromVisibleLine(line: string): string | undefined {
  const match = BULLET.exec(line);
  if (match === null) return undefined;
  const parsed = parseFactLine(line.trim());
  const claim = (parsed?.claim ?? match[1] ?? "").trim();
  return claim.length === 0 ? undefined : claim;
}

export function parseVisibleFacts(text: string): string[] {
  const facts: string[] = [];
  for (const line of text.split("\n")) {
    const claim = claimFromVisibleLine(line);
    if (claim !== undefined) facts.push(claim);
  }
  return facts;
}

function clipClaim(value: string): string {
  const cleaned = value.replace(/\s+/gu, " ").trim();
  if (cleaned.length === 0) return "";
  return cleaned.length <= FACT_CLAIM_CHARS
    ? cleaned
    : `${cleaned.slice(0, FACT_CLAIM_CHARS - 1)}…`;
}

async function withPathLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = pathLocks.get(filePath) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const settled = run.catch(() => undefined);
  pathLocks.set(filePath, settled);
  try {
    return await run;
  } finally {
    if (pathLocks.get(filePath) === settled) {
      pathLocks.delete(filePath);
    }
  }
}

async function writeAtomic(filePath: string, content: string, mode?: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, {
    encoding: "utf8",
    ...(mode === undefined ? {} : { mode }),
  });
  await rename(tmp, filePath);
}

interface KnownFactRecord {
  readonly fingerprint: string;
  readonly keys: readonly string[];
}

interface AuthorityState {
  readonly version: 2;
  readonly known: readonly KnownFactRecord[];
  readonly suppressed: readonly string[];
  readonly suppressedKeys: readonly string[];
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && FINGERPRINT.test(value);
}

function parseKnownRecord(value: unknown): KnownFactRecord | undefined {
  if (isFingerprint(value)) return { fingerprint: value, keys: [] };
  if (value === null || typeof value !== "object") return undefined;
  const row = value as { fingerprint?: unknown; keys?: unknown };
  if (!isFingerprint(row.fingerprint) || !Array.isArray(row.keys)) return undefined;
  if (row.keys.some((key) => typeof key !== "string" || key.length < MIN_SEMANTIC_KEY_CHARS)) {
    return undefined;
  }
  return {
    fingerprint: row.fingerprint,
    keys: row.keys.filter((key): key is string => typeof key === "string"),
  };
}

async function readAuthorityState(filePath: string): Promise<AuthorityState | undefined> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let raw: { version?: unknown; known?: unknown; suppressed?: unknown; suppressedKeys?: unknown };
  try {
    raw = JSON.parse(content) as typeof raw;
  } catch {
    throw new Error("visible_memory_authority_invalid");
  }
  if ((raw.version !== 1 && raw.version !== 2) || !Array.isArray(raw.known) || !Array.isArray(raw.suppressed)) {
    throw new Error("visible_memory_authority_invalid");
  }
  const known: KnownFactRecord[] = [];
  for (const item of raw.known) {
    const parsed = parseKnownRecord(item);
    if (parsed === undefined) throw new Error("visible_memory_authority_invalid");
    known.push(parsed);
  }
  if (raw.suppressed.some((value) => !isFingerprint(value))) {
    throw new Error("visible_memory_authority_invalid");
  }
  const suppressedKeys = raw.version === 2
    ? raw.suppressedKeys
    : [];
  if (raw.version === 2) {
    if (!Array.isArray(suppressedKeys)) throw new Error("visible_memory_authority_invalid");
    if (suppressedKeys.some((value) => typeof value !== "string" || value.length < MIN_SEMANTIC_KEY_CHARS)) {
      throw new Error("visible_memory_authority_invalid");
    }
  }
  return {
    version: 2,
    known,
    suppressed: raw.suppressed as string[],
    suppressedKeys: Array.isArray(suppressedKeys)
      ? suppressedKeys.filter((value): value is string => typeof value === "string")
      : [],
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameKnown(
  left: readonly KnownFactRecord[],
  right: readonly KnownFactRecord[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((row, index) => {
    const other = right[index];
    return other !== undefined
      && row.fingerprint === other.fingerprint
      && sameStrings(row.keys, other.keys);
  });
}

function visiblePrefix(text: string): string {
  const lines = text.split("\n");
  const prefix: string[] = [];
  for (const line of lines) {
    if (claimFromVisibleLine(line) !== undefined) break;
    prefix.push(line);
  }
  while (prefix.length > 0 && prefix[prefix.length - 1] === "") prefix.pop();
  if (prefix.length === 0) return "";
  return `${prefix.join("\n")}\n\n`;
}

/**
 * Three-way bullet merge: the user's next text wins for deletions and edits;
 * bullets the agent appended after the user's snapshot are kept.
 */
export function mergeVisibleMemoryEdit(input: {
  readonly baseText: string;
  readonly currentText: string;
  readonly nextText: string;
}): string {
  if (input.currentText === input.baseText) return input.nextText;
  const baseFacts = parseVisibleFacts(input.baseText);
  const currentFacts = parseVisibleFacts(input.currentText);
  const nextFacts = parseVisibleFacts(input.nextText);
  const baseSet = new Set(baseFacts.map(normalizeVisibleFact));
  const nextSet = new Set(nextFacts.map(normalizeVisibleFact));
  const deleted = new Set(
    baseFacts
      .filter((fact) => !nextSet.has(normalizeVisibleFact(fact)))
      .map(normalizeVisibleFact),
  );
  const seen = new Set(nextFacts.map(normalizeVisibleFact));
  const merged = [...nextFacts];
  for (const fact of currentFacts) {
    const key = normalizeVisibleFact(fact);
    if (baseSet.has(key) || deleted.has(key) || seen.has(key)) continue;
    seen.add(key);
    merged.push(fact);
  }
  const header = visiblePrefix(input.nextText)
    || visiblePrefix(input.currentText)
    || VISIBLE_MEMORY_HEADER;
  if (merged.length === 0) return header.endsWith("\n") ? header : `${header}\n`;
  return `${header.endsWith("\n") ? header : `${header}\n`}${merged.map((fact) => `- ${fact}`).join("\n")}\n`;
}

export class VisibleMemoryFile {
  constructor(readonly filePath: string) {}

  get authorityFilePath(): string {
    return path.join(path.dirname(this.filePath), AUTHORITY_STATE_FILE_NAME);
  }

  async exists(): Promise<boolean> {
    try {
      await access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  async readText(): Promise<string> {
    try {
      return await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  async listFacts(): Promise<string[]> {
    return parseVisibleFacts(await this.readText());
  }

  /**
   * Reconcile user edits into a suppression ledger. Fingerprints plus short
   * stripped cores are persisted; original bullets are never copied here.
   */
  async reconcileAuthority(): Promise<VisibleMemoryAuthoritySnapshot> {
    return withPathLock(this.authorityFilePath, async () => {
      const facts = await this.listFacts();
      const current = facts.map((fact) => ({
        fingerprint: visibleFactFingerprint(fact),
        keys: semanticSuppressionKeys(fact).sort(),
      }))
        .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
      const currentFingerprints = new Set(current.map((row) => row.fingerprint));
      const previous = await readAuthorityState(this.authorityFilePath);
      const suppressed = new Set(previous?.suppressed ?? []);
      const suppressedKeys = new Set(previous?.suppressedKeys ?? []);

      for (const row of previous?.known ?? []) {
        if (currentFingerprints.has(row.fingerprint)) continue;
        suppressed.add(row.fingerprint);
        for (const key of row.keys) suppressedKeys.add(key);
      }
      for (const row of current) {
        suppressed.delete(row.fingerprint);
        for (const key of row.keys) suppressedKeys.delete(key);
      }

      const state: AuthorityState = {
        version: 2,
        known: current,
        suppressed: [...suppressed].sort(),
        suppressedKeys: [...suppressedKeys].sort(),
      };
      if (
        previous === undefined
        || !sameKnown(previous.known, state.known)
        || !sameStrings(previous.suppressed, state.suppressed)
        || !sameStrings(previous.suppressedKeys, state.suppressedKeys)
      ) {
        await writeAtomic(
          this.authorityFilePath,
          `${JSON.stringify(state)}\n`,
          0o600,
        );
      }
      return {
        facts,
        suppressedFingerprints: state.suppressed,
        suppressedKeys: state.suppressedKeys,
      };
    });
  }

  /**
   * Append personal facts that are not already in the file. Project-scoped
   * claims stay in their scoped Truth/index and never enter this one file.
   */
  async appendFacts(facts: readonly string[], scope = "personal"): Promise<number> {
    if (scope.trim() !== "personal") return 0;
    await this.reconcileAuthority();
    const addedCount = await withPathLock(this.filePath, async () => {
      let current = await this.readText();
      if (current.length === 0) current = VISIBLE_MEMORY_HEADER;
      const existing = new Set(parseVisibleFacts(current).map(normalizeVisibleFact));
      const added: string[] = [];
      for (const raw of facts) {
        const claim = clipClaim(raw);
        if (claim.length === 0) continue;
        try {
          assertPersistableMemoryText(claim, "memory claim");
        } catch {
          continue;
        }
        const key = normalizeVisibleFact(claim);
        if (key.length === 0 || existing.has(key)) continue;
        existing.add(key);
        added.push(claim);
      }
      if (added.length === 0) {
        if (!(await this.exists())) {
          await writeAtomic(this.filePath, current.endsWith("\n") ? current : `${current}\n`);
        }
        return 0;
      }
      const prefix = current.endsWith("\n") ? current : `${current}\n`;
      await writeAtomic(
        this.filePath,
        `${prefix}${added.map((fact) => `- ${fact}`).join("\n")}\n`,
      );
      return added.length;
    });
    await this.reconcileAuthority();
    return addedCount;
  }

  /** Remove bullets whose normalized text matches. User wording wins if they edited it. */
  async removeFactsMatching(claim: string): Promise<boolean> {
    const key = normalizeVisibleFact(claim);
    if (key.length === 0) return false;
    await this.reconcileAuthority();
    const removed = await withPathLock(this.filePath, async () => {
      const current = await this.readText();
      if (current.length === 0) return false;
      let removed = false;
      const next = current.split("\n").filter((line) => {
        const fact = claimFromVisibleLine(line);
        if (fact !== undefined && normalizeVisibleFact(fact) === key) {
          removed = true;
          return false;
        }
        return true;
      });
      if (!removed) return false;
      await writeAtomic(this.filePath, next.join("\n"));
      return true;
    });
    if (removed) await this.reconcileAuthority();
    return removed;
  }
}

/** Copy leftover homemade facts into the visible file only when that file is new. */
export async function hydrateVisibleMemoryIfNew(
  visible: VisibleMemoryFile,
  seedFacts: readonly string[],
): Promise<number> {
  if (await visible.exists()) return 0;
  const cleaned = seedFacts.map((fact) => fact.trim()).filter((fact) => fact.length > 0);
  if (cleaned.length === 0) return 0;
  return visible.appendFacts(cleaned);
}

export async function readLegacyFactClaims(legacyFactsPath: string): Promise<string[]> {
  let text = "";
  try {
    text = await readFile(legacyFactsPath, "utf8");
  } catch {
    return [];
  }
  const claims: string[] = [];
  for (const line of text.split("\n")) {
    const parsed = parseFactLine(line);
    if (parsed !== null && parsed.claim.length > 0) claims.push(parsed.claim);
  }
  return claims;
}
