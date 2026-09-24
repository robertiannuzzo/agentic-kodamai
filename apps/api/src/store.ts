import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AuditEntry,
  RequisitionCase,
  RequisitionStage,
  WorkflowCase,
  WorkflowCommand
} from "../../../packages/contracts/src/index.js";
import { migrate } from "./migrations.js";

export class StoreError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "StoreError";
  }
}

export interface CommitContext {
  tenantId: string;
  actor: string;
  idempotencyKey: string;
  operation: string;
  requestFingerprint: string;
}

function sameAudit(left: AuditEntry, right: AuditEntry): boolean {
  return (
    left.event === right.event &&
    left.actor === right.actor &&
    left.tick === right.tick &&
    left.reference === right.reference &&
    left.revision === right.revision &&
    left.detail === right.detail
  );
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new StoreError("invalid-stored-state");
  return value;
}

function natural(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new StoreError("invalid-stored-state");
  return number;
}

function stage(value: unknown): RequisitionStage {
  if (
    value !== "draft" &&
    value !== "awaiting-review" &&
    value !== "approved" &&
    value !== "needs-rework" &&
    value !== "declined"
  ) {
    throw new StoreError("invalid-stored-state");
  }
  return value;
}

function parseAudit(value: unknown): AuditEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoreError("invalid-stored-idempotency-response");
  }
  const row = value as Record<string, unknown>;
  return {
    event: requiredString(row.event),
    actor: requiredString(row.actor),
    tick: natural(row.tick),
    reference: natural(row.reference),
    revision: natural(row.revision),
    detail: typeof row.detail === "string" ? row.detail : requiredString(row.detail)
  };
}

function parseStoredResponse(payload: string): RequisitionCase {
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    throw new StoreError("invalid-stored-idempotency-response");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoreError("invalid-stored-idempotency-response");
  }
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.history)) throw new StoreError("invalid-stored-idempotency-response");
  return {
    tenantId: requiredString(row.tenantId),
    requesterId: requiredString(row.requesterId),
    reference: natural(row.reference),
    generation: natural(row.generation),
    revision: natural(row.revision),
    stage: stage(row.stage),
    role: requiredString(row.role),
    department: requiredString(row.department),
    headcount: natural(row.headcount),
    budgetMinor: natural(row.budgetMinor),
    justification: requiredString(row.justification),
    history: row.history.map(parseAudit)
  };
}

function auditEntry(row: Record<string, unknown>, reference: number): AuditEntry {
  return {
    event: requiredString(row.event),
    actor: requiredString(row.actor),
    tick: natural(row.tick),
    reference,
    revision: natural(row.revision),
    detail: typeof row.detail === "string" ? row.detail : requiredString(row.detail)
  };
}

export function workflowCase(row: RequisitionCase): WorkflowCase {
  const { tenantId: _tenantId, requesterId: _requesterId, ...result } = row;
  return result;
}

export class RecruitmentStore {
  private readonly database: DatabaseSync;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
    `);
    migrate(this.database);
  }

  close(): void {
    this.database.close();
  }

  allocateReference(): number {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database
        .prepare("SELECT next_reference FROM reference_sequence WHERE singleton = 1")
        .get() as { next_reference: number } | undefined;
      if (row === undefined) throw new StoreError("reference-sequence-missing");
      const reference = natural(row.next_reference);
      if (reference === 0) throw new StoreError("invalid-reference-sequence");
      this.database
        .prepare("UPDATE reference_sequence SET next_reference = ? WHERE singleton = 1")
        .run(reference + 1);
      this.database.exec("COMMIT");
      return reference;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  list(tenantId: string, requesterId?: string): RequisitionCase[] {
    const ownerFilter = requesterId === undefined ? "" : " AND requester_id = ?";
    const parameters = requesterId === undefined ? [tenantId] : [tenantId, requesterId];
    const rows = this.database
      .prepare(`SELECT * FROM requisitions WHERE tenant_id = ?${ownerFilter} ORDER BY reference DESC`)
      .all(...parameters) as Array<Record<string, unknown>>;
    const histories = new Map<number, AuditEntry[]>();
    const entries = this.database
      .prepare(`SELECT audit_entries.* FROM audit_entries
        JOIN requisitions ON requisitions.reference = audit_entries.reference
        WHERE requisitions.tenant_id = ?${ownerFilter.replace("requester_id", "requisitions.requester_id")}
        ORDER BY audit_entries.reference, audit_entries.ordinal`)
      .all(...parameters) as Array<Record<string, unknown>>;
    for (const entry of entries) {
      const reference = natural(entry.reference);
      const history = histories.get(reference) ?? [];
      history.push(auditEntry(entry, reference));
      histories.set(reference, history);
    }
    return rows.map((row) => this.rowToCase(row, histories.get(natural(row.reference)) ?? []));
  }

  get(tenantId: string, reference: number): RequisitionCase | null {
    const row = this.database
      .prepare("SELECT * FROM requisitions WHERE tenant_id = ? AND reference = ?")
      .get(tenantId, reference) as Record<string, unknown> | undefined;
    return row === undefined ? null : this.rowToCase(row);
  }

  private history(reference: number): AuditEntry[] {
    const rows = this.database
      .prepare("SELECT * FROM audit_entries WHERE reference = ? ORDER BY ordinal")
      .all(reference) as Array<Record<string, unknown>>;
    return rows.map((row) => auditEntry(row, reference));
  }

  private rowToCase(row: Record<string, unknown>, history?: AuditEntry[]): RequisitionCase {
    const reference = natural(row.reference);
    return {
      tenantId: requiredString(row.tenant_id),
      requesterId: requiredString(row.requester_id),
      reference,
      generation: natural(row.generation),
      revision: natural(row.revision),
      stage: stage(row.stage),
      role: requiredString(row.role),
      department: requiredString(row.department),
      headcount: natural(row.headcount),
      budgetMinor: natural(row.budget_minor),
      justification: requiredString(row.justification),
      history: history ?? this.history(reference)
    };
  }

  private idempotencyRow(context: CommitContext): Record<string, unknown> | undefined {
    return this.database
      .prepare(`SELECT operation, request_fingerprint, response_payload
        FROM idempotency_records
        WHERE tenant_id = ? AND actor = ? AND idempotency_key = ?`)
      .get(context.tenantId, context.actor, context.idempotencyKey) as
      | Record<string, unknown>
      | undefined;
  }

  private responseFromRow(row: Record<string, unknown>, context: CommitContext): RequisitionCase {
    if (
      row.operation !== context.operation ||
      row.request_fingerprint !== context.requestFingerprint
    ) {
      throw new StoreError("idempotency-key-conflict");
    }
    return parseStoredResponse(requiredString(row.response_payload));
  }

  idempotencyResult(context: CommitContext): RequisitionCase | null {
    const row = this.idempotencyRow(context);
    return row === undefined ? null : this.responseFromRow(row, context);
  }

  commit(command: WorkflowCommand, result: WorkflowCase, context: CommitContext): RequisitionCase {
    if (result.reference !== command.reference) throw new StoreError("workflow-reference-mismatch");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.idempotencyRow(context);
      if (prior !== undefined) {
        const response = this.responseFromRow(prior, context);
        this.database.exec("ROLLBACK");
        return response;
      }

      const existing = this.get(context.tenantId, result.reference);
      let requesterId: string;
      if (command.kind === "create-draft") {
        if (existing !== null || result.generation !== 0) throw new StoreError("stale-version");
        requesterId = context.actor;
        this.database
          .prepare(`INSERT INTO requisitions
            (reference, generation, revision, stage, role, department, headcount, budget_minor,
             justification, updated_at, tenant_id, requester_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            result.reference,
            result.generation,
            result.revision,
            result.stage,
            result.role,
            result.department,
            result.headcount,
            result.budgetMinor,
            result.justification,
            Date.now(),
            context.tenantId,
            requesterId
          );
      } else {
        if (existing === null || existing.generation !== command.generation) {
          throw new StoreError("stale-version");
        }
        requesterId = existing.requesterId;
        const update = this.database
          .prepare(`UPDATE requisitions SET generation = ?, revision = ?, stage = ?, role = ?,
            department = ?, headcount = ?, budget_minor = ?, justification = ?, updated_at = ?
            WHERE tenant_id = ? AND reference = ? AND generation = ?`)
          .run(
            result.generation,
            result.revision,
            result.stage,
            result.role,
            result.department,
            result.headcount,
            result.budgetMinor,
            result.justification,
            Date.now(),
            context.tenantId,
            result.reference,
            command.generation
          );
        if (Number(update.changes) !== 1) throw new StoreError("stale-version");
      }

      const persistedHistory = existing?.history ?? [];
      if (
        persistedHistory.length > result.history.length ||
        persistedHistory.some((entry, index) => !sameAudit(entry, result.history[index] as AuditEntry))
      ) {
        throw new StoreError("audit-history-mismatch");
      }

      const insertAudit = this.database.prepare(`INSERT INTO audit_entries
        (reference, ordinal, event, actor, tick, revision, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      result.history.slice(persistedHistory.length).forEach((entry, offset) => {
        insertAudit.run(
          result.reference,
          persistedHistory.length + offset,
          entry.event,
          entry.actor,
          entry.tick,
          entry.revision,
          entry.detail
        );
      });

      const response: RequisitionCase = {
        ...result,
        tenantId: context.tenantId,
        requesterId
      };
      this.database
        .prepare(`INSERT INTO idempotency_records
          (tenant_id, actor, idempotency_key, operation, request_fingerprint, response_payload, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          context.tenantId,
          context.actor,
          context.idempotencyKey,
          context.operation,
          context.requestFingerprint,
          JSON.stringify(response),
          Date.now()
        );
      this.database.exec("COMMIT");
      return response;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // A prior successful rollback should not hide the original failure.
      }
      throw error;
    }
  }
}
