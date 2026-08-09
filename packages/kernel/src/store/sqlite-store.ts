import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Conversation,
  ConversationEvent,
  ConversationEventInput,
  ConversationInput,
  ConversationListItem,
  ConversationListOptions,
  ConversationTurn,
  ConversationTurnInput,
  ForgetMemoryResult,
  Learning,
  LearningInput,
  Mandate,
  MandateInput,
  MemoryClaim,
  MemoryInput,
  MemoryListItem,
  MemoryListOptions,
  MemorySearchOptions,
  PromoteSkillOptions,
  SkillCandidate,
  SkillCandidateInput,
  StoreMutationOptions,
  TaskInput,
  TaskSearchOptions,
  TaskTruth,
  VerifiedSkill,
  YishuStoreSnapshot,
} from "./types.js";
import {
  CONVERSATION_LIST_SUMMARY_MAX,
  CONVERSATION_LIST_TITLE_MAX,
  DEFAULT_CONVERSATION_LIST_LIMIT,
  DEFAULT_MEMORY_LIST_LIMIT,
  MAX_CONVERSATION_LIST_LIMIT,
  MAX_MEMORY_LIST_LIMIT,
  MEMORY_LIST_SUMMARY_MAX,
} from "./types.js";
import {
  assertDurableSessionScope,
  normalizeSessionScope,
  sessionScopesEqual,
  type SessionScope,
} from "../session-scope.js";
import {
  assertPersistableEventType,
  assertPersistableLearningFields,
  assertPersistableMemoryFields,
  assertPersistableSkillFields,
  SENSITIVE_CONTENT_REJECTED,
  sameEventPayload,
  sanitizeEventPayload,
  sanitizeVisibleText,
} from "./ledger-safety.js";
import type { YishuStorePort } from "./yishu-store.js";
import {
  assertStoreOperationNotAborted,
  StoreOperationCancelledError,
} from "./yishu-store.js";

/**
 * Local SQLite-backed product store (node:sqlite DatabaseSync).
 * Same port as JSON/memory backends; tables mirror evidence resources.
 */
export class SqliteYishuStore implements YishuStorePort {
  private readonly db: DatabaseSync;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  get path(): string {
    return this.dbPath;
  }

  async load(): Promise<void> {
    // Connection is live; schema ensured in constructor.
  }

  async save(): Promise<void> {
    // Writes are synchronous per mutation.
  }

  async addMemory(
    input: MemoryInput,
    options?: StoreMutationOptions,
  ): Promise<MemoryClaim> {
    const signal = options?.signal;
    assertStoreOperationNotAborted(signal);
    assertPersistableMemoryFields(input);
    assertStoreOperationNotAborted(signal);
    const id = randomUUID();
    const claim: MemoryClaim = {
      id,
      claim: input.claim,
      source: input.source,
      capturedAt: input.capturedAt,
      scope: input.scope,
      confidence: input.confidence,
      lastConfirmedAt: input.lastConfirmedAt,
      supersedes: input.supersedes,
      tags: [...input.tags],
    };
    if (input.retiredAt !== undefined) claim.retiredAt = input.retiredAt;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      assertStoreOperationNotAborted(signal);
      this.db
        .prepare(
          `INSERT INTO memories (
            id, claim, source, captured_at, scope, confidence,
            last_confirmed_at, supersedes, tags_json, retired_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          claim.id,
          claim.claim,
          claim.source,
          claim.capturedAt,
          claim.scope,
          claim.confidence,
          claim.lastConfirmedAt,
          claim.supersedes,
          JSON.stringify(claim.tags),
          claim.retiredAt ?? null,
        );
      assertStoreOperationNotAborted(signal);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (signal?.aborted || error instanceof StoreOperationCancelledError) {
        throw new StoreOperationCancelledError();
      }
      throw error;
    }
    try {
      assertStoreOperationNotAborted(signal);
    } catch (error) {
      this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(claim.id);
      throw error;
    }
    return claim;
  }

  async searchMemory(
    query: string,
    options?: MemorySearchOptions,
  ): Promise<MemoryClaim[]> {
    const all = this.listMemoriesRaw().filter((m) => m.retiredAt === undefined);
    const tokens = query
      .toLowerCase()
      .split(/[\s,，、]+/)
      .filter(Boolean);
    return all
      .filter((m) =>
        options?.scope === undefined ? true : m.scope === options.scope,
      )
      .filter((m) =>
        options?.minConfidence === undefined
          ? true
          : m.confidence >= options.minConfidence,
      )
      .filter((m) => {
        if (tokens.length === 0) return true;
        const hay =
          `${m.claim} ${m.scope} ${m.tags.join(" ")} ${m.source}`.toLowerCase();
        return tokens.some((t) => hay.includes(t));
      })
      .sort((a, b) => {
        const conf = b.confidence - a.confidence;
        if (conf !== 0) return conf;
        return b.lastConfirmedAt.localeCompare(a.lastConfirmedAt);
      });
  }

  async retireMemory(
    id: string,
    options?: StoreMutationOptions,
  ): Promise<boolean> {
    const signal = options?.signal;
    assertStoreOperationNotAborted(signal);
    const now = new Date().toISOString();
    const current = this.db
      .prepare(`SELECT retired_at FROM memories WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    if (!current || current.retired_at != null) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      assertStoreOperationNotAborted(signal);
      const result = this.db
        .prepare(
          `UPDATE memories SET retired_at = ?
           WHERE id = ? AND retired_at IS NULL`,
        )
        .run(now, id);
      if (Number(result.changes) === 0) {
        this.db.exec("ROLLBACK");
        return false;
      }
      assertStoreOperationNotAborted(signal);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (signal?.aborted || error instanceof StoreOperationCancelledError) {
        throw new StoreOperationCancelledError();
      }
      throw error;
    }
    try {
      assertStoreOperationNotAborted(signal);
    } catch (error) {
      this.db.prepare(`UPDATE memories SET retired_at = NULL WHERE id = ?`).run(id);
      throw error;
    }
    return true;
  }

  async listMemories(options: MemoryListOptions): Promise<MemoryListItem[]> {
    const scope = options.scope.trim();
    if (!scope) return [];
    const limit = clampMemoryListLimit(options.limit);
    // Soft-parse so legacy/credential-shaped rows can be filtered out of the
    // product list without crashing the whole store (write path still rejects).
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE scope = ? AND retired_at IS NULL
         ORDER BY captured_at DESC, id DESC`,
      )
      .all(scope) as Array<Record<string, unknown>>;
    const items: MemoryListItem[] = [];
    for (const row of rows) {
      if (items.length >= limit) break;
      const soft = softRowToMemoryForList(row);
      if (!soft) continue;
      const item = buildMemoryListItem(soft);
      if (item) items.push(item);
    }
    return items;
  }

  async forgetMemory(
    id: string,
    options: { expectedScope: string },
  ): Promise<ForgetMemoryResult | null> {
    const expectedScope = options.expectedScope.trim();
    if (!expectedScope) return null;
    const row = this.db
      .prepare(`SELECT id, scope FROM memories WHERE lower(id) = lower(?)`)
      .get(id) as { id: string; scope: string } | undefined;
    if (!row) {
      return { id, forgotten: true, alreadyGone: true };
    }
    if (row.scope !== expectedScope) {
      return null;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(row.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { id: row.id, forgotten: true, alreadyGone: false };
  }

  async addLearning(
    input: LearningInput,
    options?: StoreMutationOptions,
  ): Promise<Learning> {
    const signal = options?.signal;
    assertStoreOperationNotAborted(signal);
    assertPersistableLearningFields(input);
    assertStoreOperationNotAborted(signal);
    const learning: Learning = {
      id: randomUUID(),
      rule: input.rule,
      source: "user_correction",
      capturedAt: input.capturedAt ?? new Date().toISOString(),
      scope: input.scope,
      confidence: input.confidence,
    };
    if (input.examples !== undefined) learning.examples = [...input.examples];

    this.db.exec("BEGIN IMMEDIATE");
    try {
      assertStoreOperationNotAborted(signal);
      this.db
        .prepare(
          `INSERT INTO learnings (id, rule, source, captured_at, scope, confidence, examples_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          learning.id,
          learning.rule,
          learning.source,
          learning.capturedAt,
          learning.scope,
          learning.confidence,
          learning.examples ? JSON.stringify(learning.examples) : null,
        );
      assertStoreOperationNotAborted(signal);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (signal?.aborted || error instanceof StoreOperationCancelledError) {
        throw new StoreOperationCancelledError();
      }
      throw error;
    }
    try {
      assertStoreOperationNotAborted(signal);
    } catch (error) {
      this.db.prepare(`DELETE FROM learnings WHERE id = ?`).run(learning.id);
      throw error;
    }
    return learning;
  }

  async listLearnings(): Promise<Learning[]> {
    const rows = this.db
      .prepare(`SELECT * FROM learnings ORDER BY captured_at DESC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToLearning);
  }

  async addSkillCandidate(
    input: SkillCandidateInput,
    options?: StoreMutationOptions,
  ): Promise<SkillCandidate> {
    const signal = options?.signal;
    assertStoreOperationNotAborted(signal);
    const candidate: SkillCandidate = {
      id: randomUUID(),
      name: input.name,
      steps: input.steps.map((s) => ({ ...s })),
      conditions: { ...input.conditions },
      verification: [...input.verification],
      sourceTrailFrom: input.sourceTrailFrom,
      sourceTrailTo: input.sourceTrailTo,
      status: "candidate",
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    if (input.triggerPhrase !== undefined) {
      candidate.triggerPhrase = input.triggerPhrase;
    }
    assertPersistableSkillFields(candidate);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      assertStoreOperationNotAborted(signal);
      this.db
        .prepare(
          `INSERT INTO skill_candidates (
            id, name, trigger_phrase, steps_json, conditions_json, verification_json,
            source_trail_from, source_trail_to, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          candidate.id,
          candidate.name,
          candidate.triggerPhrase ?? null,
          JSON.stringify(candidate.steps),
          JSON.stringify(candidate.conditions),
          JSON.stringify(candidate.verification),
          candidate.sourceTrailFrom,
          candidate.sourceTrailTo,
          candidate.status,
          candidate.createdAt,
        );
      assertStoreOperationNotAborted(signal);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (signal?.aborted || error instanceof StoreOperationCancelledError) {
        throw new StoreOperationCancelledError();
      }
      throw error;
    }
    try {
      assertStoreOperationNotAborted(signal);
    } catch (error) {
      this.db.prepare(`DELETE FROM skill_candidates WHERE id = ?`).run(candidate.id);
      throw error;
    }
    return candidate;
  }

  async listSkillCandidates(): Promise<SkillCandidate[]> {
    const rows = this.db
      .prepare(`SELECT * FROM skill_candidates ORDER BY created_at DESC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToCandidate);
  }

  async promoteSkill(
    candidateId: string,
    opts?: PromoteSkillOptions,
  ): Promise<VerifiedSkill | null> {
    const signal = opts?.signal;
    assertStoreOperationNotAborted(signal);
    const row = this.db
      .prepare(`SELECT * FROM skill_candidates WHERE id = ?`)
      .get(candidateId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const candidate = rowToCandidate(row);
    assertPersistableSkillFields(candidate);
    const verified: VerifiedSkill = {
      id: randomUUID(),
      name: candidate.name,
      steps: candidate.steps.map((s) => ({ ...s })),
      conditions: { ...candidate.conditions },
      verification:
        opts?.verifierNote !== undefined
          ? [...candidate.verification, opts.verifierNote]
          : [...candidate.verification],
      status: "verified",
      verifiedAt: new Date().toISOString(),
      candidateId: candidate.id,
      confidence: opts?.confidence ?? 0.8,
    };
    if (candidate.triggerPhrase !== undefined) {
      verified.triggerPhrase = candidate.triggerPhrase;
    }
    assertPersistableSkillFields(verified);

    const tx = this.db.prepare("BEGIN IMMEDIATE");
    const commit = this.db.prepare("COMMIT");
    const rollback = this.db.prepare("ROLLBACK");
    tx.run();
    try {
      assertStoreOperationNotAborted(signal);
      this.db
        .prepare(`DELETE FROM skill_candidates WHERE id = ?`)
        .run(candidateId);
      this.db
        .prepare(
          `INSERT INTO verified_skills (
            id, name, trigger_phrase, steps_json, conditions_json, verification_json,
            status, verified_at, candidate_id, confidence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          verified.id,
          verified.name,
          verified.triggerPhrase ?? null,
          JSON.stringify(verified.steps),
          JSON.stringify(verified.conditions),
          JSON.stringify(verified.verification),
          verified.status,
          verified.verifiedAt,
          verified.candidateId,
          verified.confidence,
        );
      assertStoreOperationNotAborted(signal);
      commit.run();
    } catch (err) {
      rollback.run();
      if (signal?.aborted || err instanceof StoreOperationCancelledError) {
        throw new StoreOperationCancelledError();
      }
      throw err;
    }
    try {
      assertStoreOperationNotAborted(signal);
    } catch (error) {
      // A synchronous SQLite transaction cannot be interrupted half-way
      // through; if cancellation is observed just after commit, compensate
      // with the original candidate row and remove the promoted row.
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare(`DELETE FROM verified_skills WHERE id = ?`).run(verified.id);
        this.db
          .prepare(
            `INSERT INTO skill_candidates (
              id, name, trigger_phrase, steps_json, conditions_json, verification_json,
              source_trail_from, source_trail_to, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            candidate.id,
            candidate.name,
            candidate.triggerPhrase ?? null,
            JSON.stringify(candidate.steps),
            JSON.stringify(candidate.conditions),
            JSON.stringify(candidate.verification),
            candidate.sourceTrailFrom,
            candidate.sourceTrailTo,
            candidate.status,
            candidate.createdAt,
          );
        this.db.exec("COMMIT");
      } catch {
        this.db.exec("ROLLBACK");
      }
      throw error;
    }
    return verified;
  }

  async listVerifiedSkills(): Promise<VerifiedSkill[]> {
    const rows = this.db
      .prepare(`SELECT * FROM verified_skills ORDER BY verified_at DESC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToVerified);
  }

  async getSkillByName(
    name: string,
  ): Promise<VerifiedSkill | SkillCandidate | null> {
    const verified = this.db
      .prepare(`SELECT * FROM verified_skills WHERE name = ? LIMIT 1`)
      .get(name) as Record<string, unknown> | undefined;
    if (verified) return rowToVerified(verified);
    const candidate = this.db
      .prepare(`SELECT * FROM skill_candidates WHERE name = ? LIMIT 1`)
      .get(name) as Record<string, unknown> | undefined;
    if (candidate) return rowToCandidate(candidate);
    return null;
  }

  async grantMandate(input: MandateInput): Promise<Mandate> {
    const mandate: Mandate = {
      id: randomUUID(),
      actionName: input.actionName,
      scope: input.scope,
      grantedAt: input.grantedAt ?? new Date().toISOString(),
    };
    if (input.expiresAt !== undefined) mandate.expiresAt = input.expiresAt;
    if (input.note !== undefined) mandate.note = input.note;

    this.db
      .prepare(
        `INSERT INTO mandates (id, action_name, scope, granted_at, expires_at, note)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        mandate.id,
        mandate.actionName,
        mandate.scope,
        mandate.grantedAt,
        mandate.expiresAt ?? null,
        mandate.note ?? null,
      );
    return mandate;
  }

  async listMandates(): Promise<Mandate[]> {
    const rows = this.db
      .prepare(`SELECT * FROM mandates ORDER BY granted_at DESC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToMandate);
  }

  async hasMandate(actionName: string, now?: string | Date): Promise<boolean> {
    const instant =
      now === undefined
        ? Date.now()
        : typeof now === "string"
          ? Date.parse(now)
          : now.getTime();
    const rows = await this.listMandates();
    return rows.some((m) => {
      if (m.actionName !== actionName && m.actionName !== "*") return false;
      if (m.expiresAt === undefined) return true;
      const exp = Date.parse(m.expiresAt);
      if (Number.isNaN(exp)) return true;
      return exp > instant;
    });
  }

  async revokeMandate(id: string): Promise<boolean> {
    const result = this.db.prepare(`DELETE FROM mandates WHERE id = ?`).run(id);
    return Number(result.changes) > 0;
  }

  async upsertTask(input: TaskInput): Promise<TaskTruth> {
    const stamp = new Date().toISOString();
    const existing = this.db
      .prepare(`SELECT * FROM tasks WHERE id = ?`)
      .get(input.id) as Record<string, unknown> | undefined;
    const sessionScope = input.sessionScope === undefined && existing
      ? sessionScopeFromRow(existing)
      : normalizeSessionScope(input.sessionScope);
    assertDurableSessionScope(sessionScope);
    const scopeColumns = sessionScopeColumns(sessionScope);

    if (existing) {
      if (!sessionScopesEqual(sessionScopeFromRow(existing), sessionScope)) {
        throw new Error(`task_scope_conflict:${input.id}`);
      }
      this.db
        .prepare(
          `UPDATE tasks SET title = ?, status = ?, evidence_json = ?, updated_at = ?, parent_id = ?,
             scope_kind = ?, project_id = ?, project_label = ?
           WHERE id = ?`,
        )
        .run(
          input.title,
          input.status,
          JSON.stringify(input.evidence),
          input.updatedAt ?? stamp,
          input.parentId ?? null,
          scopeColumns.kind,
          scopeColumns.projectId,
          scopeColumns.projectLabel,
          input.id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO tasks (
             id, title, status, created_at, updated_at, evidence_json, parent_id,
             scope_kind, project_id, project_label
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.title,
          input.status,
          input.createdAt ?? stamp,
          input.updatedAt ?? stamp,
          JSON.stringify(input.evidence),
          input.parentId ?? null,
          scopeColumns.kind,
          scopeColumns.projectId,
          scopeColumns.projectLabel,
        );
    }

    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE id = ?`)
      .get(input.id) as Record<string, unknown>;
    return rowToTask(row);
  }

  async listTasks(options?: TaskSearchOptions): Promise<TaskTruth[]> {
    const rows = this.db
      .prepare(`SELECT * FROM tasks ORDER BY updated_at DESC`)
      .all() as Array<Record<string, unknown>>;
    const tasks = rows.map(rowToTask);
    if (options?.sessionScope === undefined) return tasks;
    const requestedScope = normalizeSessionScope(options.sessionScope);
    return tasks.filter((task) => sessionScopesEqual(task.sessionScope, requestedScope));
  }

  async upsertConversation(input: ConversationInput): Promise<Conversation> {
    const id = input.id ?? randomUUID();
    const existing = this.db
      .prepare(`SELECT * FROM conversations WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    const stamp = input.updatedAt ?? new Date().toISOString();
    const sessionScope = input.sessionScope === undefined && existing
      ? sessionScopeFromRow(existing)
      : normalizeSessionScope(input.sessionScope);
    assertDurableSessionScope(sessionScope);
    const scopeColumns = sessionScopeColumns(sessionScope);
    if (existing) {
      if (!sessionScopesEqual(sessionScopeFromRow(existing), sessionScope)) {
        throw new Error(`conversation_scope_conflict:${id}`);
      }
      const title = input.title === undefined
        ? existing.title == null ? null : String(existing.title)
        : sanitizeVisibleText(input.title, "conversation title");
      this.db
        .prepare(
          `UPDATE conversations SET updated_at = ?, status = ?, title = ?,
             scope_kind = ?, project_id = ?, project_label = ? WHERE id = ?`,
        )
        .run(
          stamp,
          input.status ?? String(existing.status),
          title,
          scopeColumns.kind,
          scopeColumns.projectId,
          scopeColumns.projectLabel,
          id,
        );
    } else {
      const title = input.title === undefined
        ? null
        : sanitizeVisibleText(input.title, "conversation title");
      this.db
        .prepare(
          `INSERT INTO conversations (
             id, created_at, updated_at, status, title, scope_kind, project_id, project_label
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.createdAt ?? stamp,
          stamp,
          input.status ?? "active",
          title,
          scopeColumns.kind,
          scopeColumns.projectId,
          scopeColumns.projectLabel,
        );
    }
    const row = this.db
      .prepare(`SELECT * FROM conversations WHERE id = ?`)
      .get(id) as Record<string, unknown>;
    return rowToConversation(row);
  }

  async upsertConversationTurn(input: ConversationTurnInput): Promise<ConversationTurn> {
    const conversation = this.db
      .prepare(`SELECT * FROM conversations WHERE id = ?`)
      .get(input.conversationId) as Record<string, unknown> | undefined;
    if (!conversation) throw new Error(`conversation ${input.conversationId} does not exist`);
    const conversationScope = sessionScopeFromRow(conversation);
    const sessionScope = input.sessionScope === undefined
      ? conversationScope
      : normalizeSessionScope(input.sessionScope);
    assertDurableSessionScope(sessionScope);
    if (!sessionScopesEqual(conversationScope, sessionScope)) {
      throw new Error(`conversation_turn_scope_conflict:${input.conversationId}`);
    }
    const scopeColumns = sessionScopeColumns(sessionScope);

    const id = input.id ?? randomUUID();
    const existing = this.db
      .prepare(`SELECT * FROM conversation_turns WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    const stamp = input.updatedAt ?? new Date().toISOString();
    if (existing) {
      if (String(existing.conversation_id) !== input.conversationId) {
        throw new Error(`conversation turn ${id} belongs to another conversation`);
      }
      if (!sessionScopesEqual(sessionScopeFromRow(existing), sessionScope)) {
        throw new Error(`conversation_turn_scope_conflict:${id}`);
      }
      if (
        input.traceId !== undefined &&
        existing.trace_id != null &&
        String(existing.trace_id) !== input.traceId
      ) {
        throw new Error(`turn_trace_conflict:${id}`);
      }
      const userInput = input.userInput === undefined
        ? existing.user_input == null ? null : String(existing.user_input)
        : sanitizeVisibleText(input.userInput, "conversation user input");
      const assistantOutput = input.assistantOutput === undefined
        ? existing.assistant_output == null ? null : String(existing.assistant_output)
        : sanitizeVisibleText(input.assistantOutput, "conversation assistant output");
      const isTerminal = String(existing.status) !== "open";
      if (input.status !== undefined && input.status !== String(existing.status)) {
        if (isTerminal || input.status === "open") {
          throw new Error(`turn_terminal_conflict:${id}`);
        }
      }
      if (
        input.userInput !== undefined &&
        existing.user_input != null &&
        String(existing.user_input) !== userInput
      ) {
        throw new Error(`turn_input_conflict:${id}`);
      }
      if (
        input.assistantOutput !== undefined &&
        existing.assistant_output != null &&
        String(existing.assistant_output) !== assistantOutput
      ) {
        throw new Error(`turn_output_conflict:${id}`);
      }
      if (isTerminal) return rowToConversationTurn(existing);
      this.db
        .prepare(
          `UPDATE conversation_turns
           SET updated_at = ?, status = ?, user_input = ?, assistant_output = ?,
             trace_id = ?, scope_kind = ?, project_id = ?, project_label = ?
           WHERE id = ?`,
        )
        .run(
          stamp,
          input.status ?? String(existing.status),
          userInput,
          assistantOutput,
          input.traceId ?? (existing.trace_id == null ? null : String(existing.trace_id)),
          scopeColumns.kind,
          scopeColumns.projectId,
          scopeColumns.projectLabel,
          id,
        );
    } else {
      const sequenceRow = this.db
        .prepare(
          `SELECT COALESCE(MAX(sequence), -1) + 1 AS next_sequence
           FROM conversation_turns WHERE conversation_id = ?`,
        )
        .get(input.conversationId) as Record<string, unknown>;
      const userInput = input.userInput === undefined
        ? null
        : sanitizeVisibleText(input.userInput, "conversation user input");
      const assistantOutput = input.assistantOutput === undefined
        ? null
        : sanitizeVisibleText(input.assistantOutput, "conversation assistant output");
      this.db
        .prepare(
          `INSERT INTO conversation_turns (
            id, conversation_id, sequence, created_at, updated_at, status,
            user_input, assistant_output, trace_id, scope_kind, project_id, project_label
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.conversationId,
          Number(sequenceRow.next_sequence),
          input.createdAt ?? stamp,
          stamp,
          input.status ?? "open",
          userInput,
          assistantOutput,
          input.traceId ?? null,
          scopeColumns.kind,
          scopeColumns.projectId,
          scopeColumns.projectLabel,
        );
    }
    this.db
      .prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`)
      .run(stamp, input.conversationId);
    const row = this.db
      .prepare(`SELECT * FROM conversation_turns WHERE id = ?`)
      .get(id) as Record<string, unknown>;
    return rowToConversationTurn(row);
  }

  async appendConversationEvent(input: ConversationEventInput): Promise<ConversationEvent> {
    const conversation = this.db
      .prepare(`SELECT id FROM conversations WHERE id = ?`)
      .get(input.conversationId) as Record<string, unknown> | undefined;
    if (!conversation) throw new Error(`conversation ${input.conversationId} does not exist`);

    if (input.id !== undefined) {
      const existing = this.db
        .prepare(`SELECT * FROM conversation_events WHERE id = ?`)
        .get(input.id) as Record<string, unknown> | undefined;
      if (existing) {
        if (String(existing.conversation_id) !== input.conversationId) {
          throw new Error(`event_id_conflict:${input.id}`);
        }
        assertPersistableEventType(input.type);
        const payload = sanitizeEventPayload(input.payload);
        const existingEvent = rowToConversationEvent(existing);
        const sameTime = input.occurredAt === undefined || existingEvent.occurredAt === input.occurredAt;
        if (
          (existingEvent.turnId ?? null) !== (input.turnId ?? null) ||
          existingEvent.type !== input.type ||
          !sameTime ||
          !sameEventPayload(existingEvent.payload, payload)
        ) {
          throw new Error(`event_id_conflict:${input.id}`);
        }
        return existingEvent;
      }
    }

    if (input.turnId !== undefined) {
      const turn = this.db
        .prepare(`SELECT conversation_id, status FROM conversation_turns WHERE id = ?`)
        .get(input.turnId) as Record<string, unknown> | undefined;
      if (!turn || String(turn.conversation_id) !== input.conversationId) {
        throw new Error(`conversation event turn ${input.turnId} does not belong to conversation`);
      }
      if (String(turn.status) !== "open") {
        throw new Error(`late_event_rejected:${input.turnId}`);
      }
    }

    assertPersistableEventType(input.type);
    const id = input.id ?? randomUUID();
    const payload = sanitizeEventPayload(input.payload);
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const sequenceRow = this.db
        .prepare(
          `SELECT COALESCE(MAX(sequence), -1) + 1 AS next_sequence
           FROM conversation_events WHERE conversation_id = ?`,
        )
        .get(input.conversationId) as Record<string, unknown>;
      this.db
        .prepare(
          `INSERT INTO conversation_events (
            id, conversation_id, turn_id, sequence, type, occurred_at, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.conversationId,
          input.turnId ?? null,
          Number(sequenceRow.next_sequence),
          input.type,
          occurredAt,
          JSON.stringify(payload),
        );
      this.db
        .prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`)
        .run(occurredAt, input.conversationId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const row = this.db
      .prepare(`SELECT * FROM conversation_events WHERE id = ?`)
      .get(id) as Record<string, unknown>;
    return rowToConversationEvent(row);
  }

  async getConversation(id: string): Promise<Conversation | null> {
    // UUID case may differ between Swift (uppercase) and seed writers (lowercase).
    const row = this.db
      .prepare(`SELECT * FROM conversations WHERE id = ? COLLATE NOCASE`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToConversation(row) : null;
  }

  async getConversationTurn(id: string): Promise<ConversationTurn | null> {
    const row = this.db
      .prepare(`SELECT * FROM conversation_turns WHERE id = ? COLLATE NOCASE`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToConversationTurn(row) : null;
  }

  async listConversationTurns(conversationId: string): Promise<ConversationTurn[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_turns WHERE conversation_id = ? COLLATE NOCASE ORDER BY sequence ASC`,
      )
      .all(conversationId) as Array<Record<string, unknown>>;
    return rows.map(rowToConversationTurn);
  }

  async listConversationEvents(conversationId: string): Promise<ConversationEvent[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_events WHERE conversation_id = ? COLLATE NOCASE ORDER BY sequence ASC`,
      )
      .all(conversationId) as Array<Record<string, unknown>>;
    return rows.map(rowToConversationEvent);
  }

  async listConversations(options?: ConversationListOptions): Promise<ConversationListItem[]> {
    if (options?.sessionScope?.kind === "private") {
      return [];
    }
    const limit = clampConversationListLimit(options?.limit);
    const requestedScope = options?.sessionScope === undefined
      ? undefined
      : normalizeSessionScope(options.sessionScope);
    const includeArchived = options?.includeArchived === true;
    const archivedClause = includeArchived ? "" : " AND status != 'archived'";

    let rows: Array<Record<string, unknown>>;
    if (requestedScope === undefined) {
      rows = this.db
        .prepare(
          `SELECT * FROM conversations
           WHERE scope_kind != 'private'${archivedClause}
           ORDER BY updated_at DESC, id DESC
           LIMIT ?`,
        )
        .all(limit) as Array<Record<string, unknown>>;
    } else if (requestedScope.kind === "personal") {
      rows = this.db
        .prepare(
          `SELECT * FROM conversations
           WHERE scope_kind = 'personal'${archivedClause}
           ORDER BY updated_at DESC, id DESC
           LIMIT ?`,
        )
        .all(limit) as Array<Record<string, unknown>>;
    } else if (requestedScope.kind === "project") {
      rows = this.db
        .prepare(
          `SELECT * FROM conversations
           WHERE scope_kind = 'project' AND project_id = ?${archivedClause}
           ORDER BY updated_at DESC, id DESC
           LIMIT ?`,
        )
        .all(requestedScope.projectId, limit) as Array<Record<string, unknown>>;
    } else {
      return [];
    }

    return rows.map((row) => {
      const conversation = rowToConversation(row);
      const turnRows = this.db
        .prepare(
          `SELECT * FROM conversation_turns
           WHERE conversation_id = ?
           ORDER BY sequence ASC`,
        )
        .all(conversation.id) as Array<Record<string, unknown>>;
      const turns = turnRows.map(rowToConversationTurn);
      return buildConversationListItem(conversation, turns);
    });
  }

  async archiveConversation(
    id: string,
    options?: { expectedScope?: SessionScope },
  ): Promise<Conversation | null> {
    const existing = this.db
      .prepare(`SELECT * FROM conversations WHERE id = ? COLLATE NOCASE`)
      .get(id) as Record<string, unknown> | undefined;
    if (!existing) return null;
    const conversation = rowToConversation(existing);
    if (conversation.sessionScope.kind === "private") return null;
    if (options?.expectedScope !== undefined) {
      const expected = normalizeSessionScope(options.expectedScope);
      if (!sessionScopesEqual(conversation.sessionScope, expected)) return null;
    }
    if (conversation.status === "archived") {
      return conversation;
    }
    const stamp = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE conversations SET status = 'archived', updated_at = ? WHERE id = ? COLLATE NOCASE`,
      )
      .run(stamp, id);
    const row = this.db
      .prepare(`SELECT * FROM conversations WHERE id = ? COLLATE NOCASE`)
      .get(id) as Record<string, unknown>;
    return rowToConversation(row);
  }

  getSnapshot(): YishuStoreSnapshot {
    return {
      memories: this.listMemoriesRaw(),
      learnings: this.db
        .prepare(`SELECT * FROM learnings`)
        .all()
        .map((r) => rowToLearning(r as Record<string, unknown>)),
      skillCandidates: this.db
        .prepare(`SELECT * FROM skill_candidates`)
        .all()
        .map((r) => rowToCandidate(r as Record<string, unknown>)),
      verifiedSkills: this.db
        .prepare(`SELECT * FROM verified_skills`)
        .all()
        .map((r) => rowToVerified(r as Record<string, unknown>)),
      mandates: this.db
        .prepare(`SELECT * FROM mandates`)
        .all()
        .map((r) => rowToMandate(r as Record<string, unknown>)),
      tasks: this.db
        .prepare(`SELECT * FROM tasks`)
        .all()
        .map((r) => rowToTask(r as Record<string, unknown>)),
      conversations: this.db
        .prepare(`SELECT * FROM conversations ORDER BY created_at ASC`)
        .all()
        .map((r) => rowToConversation(r as Record<string, unknown>)),
      turns: this.db
        .prepare(`SELECT * FROM conversation_turns ORDER BY conversation_id ASC, sequence ASC`)
        .all()
        .map((r) => rowToConversationTurn(r as Record<string, unknown>)),
      events: this.db
        .prepare(`SELECT * FROM conversation_events ORDER BY conversation_id ASC, sequence ASC`)
        .all()
        .map((r) => rowToConversationEvent(r as Record<string, unknown>)),
    };
  }

  close(): void {
    this.db.close();
  }

  private listMemoriesRaw(): MemoryClaim[] {
    const rows = this.db
      .prepare(`SELECT * FROM memories ORDER BY last_confirmed_at DESC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToMemory);
  }

  private migrate(): void {
    this.db.exec("PRAGMA foreign_keys = ON;");
    const versionRow = this.db
      .prepare("PRAGMA user_version")
      .get() as Record<string, unknown> | undefined;
    const currentVersion = Number(versionRow?.user_version ?? 0);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        claim TEXT NOT NULL,
        source TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        scope TEXT NOT NULL,
        confidence REAL NOT NULL,
        last_confirmed_at TEXT NOT NULL,
        supersedes TEXT,
        tags_json TEXT NOT NULL,
        retired_at TEXT
      );
      CREATE TABLE IF NOT EXISTS learnings (
        id TEXT PRIMARY KEY,
        rule TEXT NOT NULL,
        source TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        scope TEXT NOT NULL,
        confidence REAL NOT NULL,
        examples_json TEXT
      );
      CREATE TABLE IF NOT EXISTS skill_candidates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        trigger_phrase TEXT,
        steps_json TEXT NOT NULL,
        conditions_json TEXT NOT NULL,
        verification_json TEXT NOT NULL,
        source_trail_from TEXT NOT NULL,
        source_trail_to TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS verified_skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        trigger_phrase TEXT,
        steps_json TEXT NOT NULL,
        conditions_json TEXT NOT NULL,
        verification_json TEXT NOT NULL,
        status TEXT NOT NULL,
        verified_at TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        confidence REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mandates (
        id TEXT PRIMARY KEY,
        action_name TEXT NOT NULL,
        scope TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        expires_at TEXT,
        note TEXT
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        parent_id TEXT,
        scope_kind TEXT NOT NULL DEFAULT 'personal',
        project_id TEXT,
        project_label TEXT
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT,
        scope_kind TEXT NOT NULL DEFAULT 'personal',
        project_id TEXT,
        project_label TEXT
      );
      CREATE TABLE IF NOT EXISTS conversation_turns (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        trace_id TEXT,
        user_input TEXT,
        assistant_output TEXT,
        scope_kind TEXT NOT NULL DEFAULT 'personal',
        project_id TEXT,
        project_label TEXT,
        UNIQUE (conversation_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS conversation_events (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES conversation_turns(id) ON DELETE SET NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE (conversation_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_turns_conversation
        ON conversation_turns (conversation_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_conversation_events_conversation
        ON conversation_events (conversation_id, sequence);
    `);

    // Existing databases created before the ledger had no trace_id column.
    // ALTER is intentionally additive; no existing evidence rows are touched.
    try {
      this.db.exec("ALTER TABLE conversation_turns ADD COLUMN trace_id TEXT;");
    } catch {
      // Fresh databases already declare trace_id; SQLite reports duplicate
      // column and the schema is otherwise complete.
    }
    const scopeColumns = [
      ["tasks", "scope_kind", "TEXT NOT NULL DEFAULT 'personal'"],
      ["tasks", "project_id", "TEXT"],
      ["tasks", "project_label", "TEXT"],
      ["conversations", "scope_kind", "TEXT NOT NULL DEFAULT 'personal'"],
      ["conversations", "project_id", "TEXT"],
      ["conversations", "project_label", "TEXT"],
      ["conversation_turns", "scope_kind", "TEXT NOT NULL DEFAULT 'personal'"],
      ["conversation_turns", "project_id", "TEXT"],
      ["conversation_turns", "project_label", "TEXT"],
    ] as const;
    for (const [table, column, declaration] of scopeColumns) {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration};`);
      } catch {
        // Fresh/current schemas already contain the additive column.
      }
    }
    if (currentVersion < 3) {
      this.db.exec("PRAGMA user_version = 3;");
    }
  }
}

function parseJsonArray(value: unknown): unknown[] {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: unknown): Record<string, string> {
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}

function skillRecordError(): Error {
  return new Error(SENSITIVE_CONTENT_REJECTED)
}

function parseSkillJsonArray(value: unknown): unknown[] {
  if (typeof value !== "string" || value.length === 0) throw skillRecordError()
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) throw skillRecordError()
    return parsed
  } catch (error) {
    if (error instanceof Error && error.message === SENSITIVE_CONTENT_REJECTED) throw error
    throw skillRecordError()
  }
}

function parseSkillJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length === 0) throw skillRecordError()
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw skillRecordError()
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof Error && error.message === SENSITIVE_CONTENT_REJECTED) throw error
    throw skillRecordError()
  }
}

function skillRowText(row: Record<string, unknown>, field: string): string {
  const value = row[field]
  if (typeof value !== "string") throw skillRecordError()
  return value
}

function parsePayload(value: unknown): ReturnType<typeof sanitizeEventPayload> {
  if (typeof value !== "string" || value.length === 0) {
    return sanitizeEventPayload({});
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("yishu sqlite: invalid conversation event payload JSON");
  }
  return sanitizeEventPayload(parsed);
}

function clampConversationListLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_CONVERSATION_LIST_LIMIT;
  }
  return Math.max(1, Math.min(MAX_CONVERSATION_LIST_LIMIT, Math.floor(limit)));
}

function clampMemoryListLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_MEMORY_LIST_LIMIT;
  }
  return Math.max(1, Math.min(MAX_MEMORY_LIST_LIMIT, Math.floor(limit)));
}

function clipListText(value: string, max: number): string {
  const cleaned = value.replace(/\s+/gu, " ").trim();
  if (cleaned.length === 0) return "";
  if (cleaned.length <= max) return cleaned;
  if (max <= 1) return "…";
  return `${cleaned.slice(0, max - 1).trimEnd()}…`;
}

function isSafeMemoryListText(value: string): boolean {
  if (!value || value.trim().length === 0) return false;
  if (/(api[_-]?key|password|secret|token|bearer)\s*[:=]/i.test(value)) {
    return false;
  }
  if (/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(value)) return false;
  if (/data:image\//i.test(value)) return false;
  if (/sk-[A-Za-z0-9]{16,}/.test(value)) return false;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return false;
  return true;
}

function buildMemoryListItem(memory: MemoryClaim): MemoryListItem | null {
  if (memory.retiredAt !== undefined) return null;
  if (!isSafeMemoryListText(memory.claim)) return null;
  const summary = clipListText(memory.claim, MEMORY_LIST_SUMMARY_MAX);
  if (!summary) return null;
  return {
    id: memory.id,
    summary,
    capturedAt: memory.capturedAt,
    lastConfirmedAt: memory.lastConfirmedAt,
    source: memory.source,
    scope: memory.scope,
  };
}

function buildConversationListItem(
  conversation: Conversation,
  turns: ConversationTurn[],
): ConversationListItem {
  const ordered = [...turns].sort((a, b) => a.sequence - b.sequence);
  const latest = ordered.length > 0 ? ordered[ordered.length - 1] : undefined;
  const firstUser = ordered.find((turn) => {
    const text = turn.userInput?.trim();
    return text !== undefined && text.length > 0;
  });

  let titleSource = "";
  if (conversation.title !== undefined && conversation.title.trim().length > 0) {
    titleSource = sanitizeVisibleText(conversation.title, "conversation title");
  } else if (firstUser?.userInput) {
    titleSource = sanitizeVisibleText(firstUser.userInput, "conversation user input");
  }
  const title = clipListText(titleSource, CONVERSATION_LIST_TITLE_MAX) || "未命名对话";

  let summarySource = "";
  if (latest?.assistantOutput && latest.assistantOutput.trim().length > 0) {
    summarySource = sanitizeVisibleText(latest.assistantOutput, "conversation assistant output");
  } else if (latest?.userInput && latest.userInput.trim().length > 0) {
    summarySource = sanitizeVisibleText(latest.userInput, "conversation user input");
  }
  const summary = clipListText(summarySource, CONVERSATION_LIST_SUMMARY_MAX);

  return {
    id: conversation.id,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    status: conversation.status,
    sessionScope: conversation.sessionScope,
    title,
    summary,
  };
}

function rowToConversation(row: Record<string, unknown>): Conversation {
  const status = row.status;
  if (status !== "active" && status !== "completed" && status !== "archived") {
    throw new Error("yishu sqlite: invalid conversation status");
  }
  const conversation: Conversation = {
    id: String(row.id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    status,
    sessionScope: sessionScopeFromRow(row),
  };
  if (row.title != null) conversation.title = sanitizeVisibleText(String(row.title), "conversation title");
  return conversation;
}

function rowToConversationTurn(row: Record<string, unknown>): ConversationTurn {
  const status = row.status;
  if (status !== "open" && status !== "completed" && status !== "cancelled" && status !== "failed") {
    throw new Error("yishu sqlite: invalid conversation turn status");
  }
  const turn: ConversationTurn = {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    sequence: Number(row.sequence),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    status,
    sessionScope: sessionScopeFromRow(row),
  };
  if (row.trace_id != null) turn.traceId = String(row.trace_id);
  if (row.user_input != null) turn.userInput = sanitizeVisibleText(String(row.user_input), "conversation user input");
  if (row.assistant_output != null) {
    turn.assistantOutput = sanitizeVisibleText(String(row.assistant_output), "conversation assistant output");
  }
  return turn;
}

function rowToConversationEvent(row: Record<string, unknown>): ConversationEvent {
  const type = String(row.type);
  assertPersistableEventType(type);
  const event: ConversationEvent = {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    sequence: Number(row.sequence),
    type,
    occurredAt: String(row.occurred_at),
    payload: parsePayload(row.payload_json),
  };
  if (row.turn_id != null) event.turnId = String(row.turn_id);
  return event;
}

function rowToMemory(row: Record<string, unknown>): MemoryClaim {
  const tags = parseJsonArray(row.tags_json) as string[];
  assertPersistableMemoryFields({
    claim: row.claim,
    scope: row.scope,
    tags,
  });
  const claim: MemoryClaim = {
    id: String(row.id),
    claim: String(row.claim),
    source: row.source as MemoryClaim["source"],
    capturedAt: String(row.captured_at),
    scope: String(row.scope),
    confidence: Number(row.confidence),
    lastConfirmedAt: String(row.last_confirmed_at),
    supersedes: row.supersedes == null ? null : String(row.supersedes),
    tags,
  };
  if (row.retired_at != null) claim.retiredAt = String(row.retired_at);
  return claim;
}

/**
 * List-only parse: keep shape for safety filtering even when claim text would
 * fail write-time persistable checks. Never used for mutations/snapshots.
 */
function softRowToMemoryForList(row: Record<string, unknown>): MemoryClaim | null {
  if (typeof row.id !== "string" || typeof row.claim !== "string") return null;
  if (typeof row.scope !== "string" || typeof row.source !== "string") return null;
  if (typeof row.captured_at !== "string") return null;
  const tags = parseJsonArray(row.tags_json) as string[];
  const claim: MemoryClaim = {
    id: row.id,
    claim: row.claim,
    source: row.source as MemoryClaim["source"],
    capturedAt: row.captured_at,
    scope: row.scope,
    confidence: Number(row.confidence ?? 0),
    lastConfirmedAt:
      typeof row.last_confirmed_at === "string" ? row.last_confirmed_at : row.captured_at,
    supersedes: row.supersedes == null ? null : String(row.supersedes),
    tags: Array.isArray(tags) ? tags : [],
  };
  if (row.retired_at != null) claim.retiredAt = String(row.retired_at);
  return claim;
}

function rowToLearning(row: Record<string, unknown>): Learning {
  const examples = parseJsonArray(row.examples_json) as string[];
  assertPersistableLearningFields({
    rule: row.rule,
    scope: row.scope,
    examples: row.examples_json == null ? undefined : examples,
  });
  const learning: Learning = {
    id: String(row.id),
    rule: String(row.rule),
    source: "user_correction",
    capturedAt: String(row.captured_at),
    scope: String(row.scope),
    confidence: Number(row.confidence),
  };
  if (row.examples_json != null) learning.examples = examples as string[];
  return learning;
}

function rowToCandidate(row: Record<string, unknown>): SkillCandidate {
  const candidate: SkillCandidate = {
    id: skillRowText(row, "id"),
    name: skillRowText(row, "name"),
    steps: parseSkillJsonArray(row.steps_json) as SkillCandidate["steps"],
    conditions: parseSkillJsonObject(row.conditions_json) as Record<string, string>,
    verification: parseSkillJsonArray(row.verification_json) as string[],
    sourceTrailFrom: skillRowText(row, "source_trail_from"),
    sourceTrailTo: skillRowText(row, "source_trail_to"),
    status: skillRowText(row, "status") as SkillCandidate["status"],
    createdAt: skillRowText(row, "created_at"),
  };
  if (row.trigger_phrase != null) {
    candidate.triggerPhrase = skillRowText(row, "trigger_phrase");
  }
  if (candidate.status !== "candidate") throw skillRecordError()
  assertPersistableSkillFields(candidate)
  return candidate;
}

function rowToVerified(row: Record<string, unknown>): VerifiedSkill {
  const skill: VerifiedSkill = {
    id: skillRowText(row, "id"),
    name: skillRowText(row, "name"),
    steps: parseSkillJsonArray(row.steps_json) as VerifiedSkill["steps"],
    conditions: parseSkillJsonObject(row.conditions_json) as Record<string, string>,
    verification: parseSkillJsonArray(row.verification_json) as string[],
    status: skillRowText(row, "status") as VerifiedSkill["status"],
    verifiedAt: skillRowText(row, "verified_at"),
    candidateId: skillRowText(row, "candidate_id"),
    confidence: typeof row.confidence === "number" ? row.confidence : Number.NaN,
  };
  if (row.trigger_phrase != null) {
    skill.triggerPhrase = skillRowText(row, "trigger_phrase");
  }
  if (skill.status !== "verified" || !Number.isFinite(skill.confidence)) {
    throw skillRecordError()
  }
  assertPersistableSkillFields(skill)
  return skill;
}

function rowToMandate(row: Record<string, unknown>): Mandate {
  const mandate: Mandate = {
    id: String(row.id),
    actionName: String(row.action_name),
    scope: String(row.scope),
    grantedAt: String(row.granted_at),
  };
  if (row.expires_at != null) mandate.expiresAt = String(row.expires_at);
  if (row.note != null) mandate.note = String(row.note);
  return mandate;
}

function rowToTask(row: Record<string, unknown>): TaskTruth {
  const task: TaskTruth = {
    id: String(row.id),
    title: String(row.title),
    status: row.status as TaskTruth["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    evidence: parseJsonArray(row.evidence_json) as string[],
    sessionScope: sessionScopeFromRow(row),
  };
  if (row.parent_id != null) task.parentId = String(row.parent_id);
  return task;
}

function sessionScopeColumns(scope: SessionScope): {
  kind: SessionScope["kind"];
  projectId: string | null;
  projectLabel: string | null;
} {
  if (scope.kind !== "project") {
    return { kind: scope.kind, projectId: null, projectLabel: null };
  }
  return {
    kind: scope.kind,
    projectId: scope.projectId,
    projectLabel: scope.projectLabel ?? null,
  };
}

function sessionScopeFromRow(row: Record<string, unknown>): SessionScope {
  const kind = row.scope_kind == null ? "personal" : String(row.scope_kind);
  if (kind === "project") {
    const scope = normalizeSessionScope({
      kind,
      projectId: row.project_id == null ? undefined : String(row.project_id),
      projectLabel: row.project_label == null ? undefined : String(row.project_label),
    });
    assertDurableSessionScope(scope);
    return scope;
  }
  const scope = normalizeSessionScope({ kind });
  assertDurableSessionScope(scope);
  return scope;
}
