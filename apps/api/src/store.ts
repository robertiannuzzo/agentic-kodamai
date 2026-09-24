import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AdvertSchema,
  ApplicationAcknowledgement,
  ApplicationRecord,
  ApplicationSubmission,
  AuditEntry,
  OpenAdvert,
  RequisitionCase,
  RequisitionStage,
  ScoreReceipt,
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

export interface ApplicationCommit {
  reference: number;
  submission: ApplicationSubmission;
  cv: { locator: string; version: string };
  receipt: ScoreReceipt;
}

type Row = Record<string, unknown>;

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

function sameSchema(left: AdvertSchema, right: AdvertSchema): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new StoreError("invalid-stored-state");
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new StoreError("invalid-stored-state");
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
    value !== "declined" &&
    value !== "advertising"
  ) {
    throw new StoreError("invalid-stored-state");
  }
  return value;
}

function auditEntry(row: Row, reference: number): AuditEntry {
  return {
    event: requiredString(row.event),
    actor: requiredString(row.actor),
    tick: natural(row.tick),
    reference,
    revision: natural(row.revision),
    detail: text(row.detail)
  };
}

function parseJson(payload: string): Row {
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    throw new StoreError("invalid-stored-idempotency-response");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoreError("invalid-stored-idempotency-response");
  }
  return value as Row;
}

function parseStoredCase(payload: string): RequisitionCase {
  const row = parseJson(payload);
  if (!Array.isArray(row.history)) throw new StoreError("invalid-stored-idempotency-response");
  const advert = row.advert as AdvertSchema | null | undefined;
  if (advert !== null && advert !== undefined && (!Array.isArray(advert.questions) || !Array.isArray(advert.skills))) {
    throw new StoreError("invalid-stored-idempotency-response");
  }
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
    history: (row.history as Row[]).map((entry) => auditEntry(entry, natural(entry.reference))),
    advert: advert ?? null
  };
}

function parseStoredAcknowledgement(payload: string): ApplicationAcknowledgement {
  const row = parseJson(payload);
  if (row.status !== "received") throw new StoreError("invalid-stored-idempotency-response");
  return {
    reference: natural(row.reference),
    applicationId: natural(row.applicationId),
    status: "received"
  };
}

export function workflowCase(row: RequisitionCase): WorkflowCase {
  const { tenantId: _tenantId, requesterId: _requesterId, ...result } = row;
  return result;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/u.test(error.message);
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

  private transaction<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // A prior successful rollback should not hide the original failure.
      }
      throw error;
    }
  }

  allocateReference(): number {
    return this.transaction(() => {
      const row = this.database
        .prepare("SELECT next_reference FROM reference_sequence WHERE singleton = 1")
        .get() as { next_reference: number } | undefined;
      if (row === undefined) throw new StoreError("reference-sequence-missing");
      const reference = natural(row.next_reference);
      if (reference === 0) throw new StoreError("invalid-reference-sequence");
      this.database
        .prepare("UPDATE reference_sequence SET next_reference = ? WHERE singleton = 1")
        .run(reference + 1);
      return reference;
    });
  }

  allocateApplicationId(reference: number): number {
    return this.transaction(() => {
      this.database
        .prepare("INSERT OR IGNORE INTO application_sequence (reference, next_id) VALUES (?, 1)")
        .run(reference);
      const row = this.database
        .prepare("SELECT next_id FROM application_sequence WHERE reference = ?")
        .get(reference) as { next_id: number };
      const identifier = natural(row.next_id);
      this.database
        .prepare("UPDATE application_sequence SET next_id = ? WHERE reference = ?")
        .run(identifier + 1, reference);
      return identifier;
    });
  }

  list(tenantId: string, requesterId?: string): RequisitionCase[] {
    const ownerFilter = requesterId === undefined ? "" : " AND requisitions.requester_id = ?";
    const parameters = requesterId === undefined ? [tenantId] : [tenantId, requesterId];
    const scope = `JOIN requisitions ON requisitions.reference = child.reference
      WHERE requisitions.tenant_id = ?${ownerFilter}`;
    const rows = this.database
      .prepare(`SELECT * FROM requisitions WHERE tenant_id = ?${ownerFilter} ORDER BY reference DESC`)
      .all(...parameters) as Row[];
    const histories = new Map<number, AuditEntry[]>();
    for (const entry of this.database
      .prepare(`SELECT child.* FROM audit_entries AS child ${scope} ORDER BY child.reference, child.ordinal`)
      .all(...parameters) as Row[]) {
      const reference = natural(entry.reference);
      histories.set(reference, [...(histories.get(reference) ?? []), auditEntry(entry, reference)]);
    }
    const schemas = this.schemas(scope, parameters);
    return rows.map((row) => {
      const reference = natural(row.reference);
      return this.rowToCase(row, histories.get(reference) ?? [], schemas.get(reference) ?? null);
    });
  }

  get(tenantId: string, reference: number): RequisitionCase | null {
    const row = this.database
      .prepare("SELECT * FROM requisitions WHERE tenant_id = ? AND reference = ?")
      .get(tenantId, reference) as Row | undefined;
    if (row === undefined) return null;
    const history = (
      this.database
        .prepare("SELECT * FROM audit_entries WHERE reference = ? ORDER BY ordinal")
        .all(reference) as Row[]
    ).map((entry) => auditEntry(entry, reference));
    const schemas = this.schemas("WHERE child.reference = ?", [reference]);
    return this.rowToCase(row, history, schemas.get(reference) ?? null);
  }

  private schemas(scope: string, parameters: Array<string | number>): Map<number, AdvertSchema> {
    const result = new Map<number, AdvertSchema>();
    const entry = (reference: number): AdvertSchema => {
      const existing = result.get(reference);
      if (existing !== undefined) return existing;
      const created: AdvertSchema = { questions: [], skills: [] };
      result.set(reference, created);
      return created;
    };
    for (const row of this.database
      .prepare(`SELECT child.* FROM advert_questions AS child ${scope} ORDER BY child.reference, child.ordinal`)
      .all(...parameters) as Row[]) {
      entry(natural(row.reference)).questions.push({
        questionId: natural(row.question_id),
        prompt: text(row.prompt),
        expected: text(row.expected)
      });
    }
    for (const row of this.database
      .prepare(`SELECT child.* FROM advert_skills AS child ${scope} ORDER BY child.reference, child.ordinal`)
      .all(...parameters) as Row[]) {
      entry(natural(row.reference)).skills.push({
        skillId: natural(row.skill_id),
        keyword: text(row.keyword),
        weight: natural(row.weight),
        targetYears: natural(row.target_years)
      });
    }
    return result;
  }

  private rowToCase(row: Row, history: AuditEntry[], advert: AdvertSchema | null): RequisitionCase {
    return {
      tenantId: requiredString(row.tenant_id),
      requesterId: requiredString(row.requester_id),
      reference: natural(row.reference),
      generation: natural(row.generation),
      revision: natural(row.revision),
      stage: stage(row.stage),
      role: requiredString(row.role),
      department: requiredString(row.department),
      headcount: natural(row.headcount),
      budgetMinor: natural(row.budget_minor),
      justification: requiredString(row.justification),
      history,
      advert
    };
  }

  private idempotencyPayload(context: CommitContext): string | null {
    const row = this.database
      .prepare(`SELECT operation, request_fingerprint, response_payload
        FROM idempotency_records
        WHERE tenant_id = ? AND actor = ? AND idempotency_key = ?`)
      .get(context.tenantId, context.actor, context.idempotencyKey) as Row | undefined;
    if (row === undefined) return null;
    if (row.operation !== context.operation || row.request_fingerprint !== context.requestFingerprint) {
      throw new StoreError("idempotency-key-conflict");
    }
    return requiredString(row.response_payload);
  }

  private recordIdempotency(context: CommitContext, response: unknown): void {
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
  }

  idempotencyResult(context: CommitContext): RequisitionCase | null {
    const payload = this.idempotencyPayload(context);
    return payload === null ? null : parseStoredCase(payload);
  }

  applicationIdempotencyResult(context: CommitContext): ApplicationAcknowledgement | null {
    const payload = this.idempotencyPayload(context);
    return payload === null ? null : parseStoredAcknowledgement(payload);
  }

  commit(command: WorkflowCommand, result: WorkflowCase, context: CommitContext): RequisitionCase {
    if (result.reference !== command.reference) throw new StoreError("workflow-reference-mismatch");
    return this.transaction(() => {
      const prior = this.idempotencyPayload(context);
      if (prior !== null) return parseStoredCase(prior);

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

      const persistedAdvert = existing?.advert ?? null;
      if (persistedAdvert !== null) {
        if (result.advert === null || !sameSchema(persistedAdvert, result.advert)) {
          throw new StoreError("advert-schema-mismatch");
        }
      } else if (result.advert !== null) {
        this.insertSchema(result.reference, result.advert);
      }

      const response: RequisitionCase = { ...result, tenantId: context.tenantId, requesterId };
      this.recordIdempotency(context, response);
      return response;
    });
  }

  private insertSchema(reference: number, schema: AdvertSchema): void {
    const question = this.database.prepare(`INSERT INTO advert_questions
      (reference, ordinal, question_id, prompt, expected) VALUES (?, ?, ?, ?, ?)`);
    schema.questions.forEach((q, ordinal) => {
      question.run(reference, ordinal, q.questionId, q.prompt, q.expected);
    });
    const skill = this.database.prepare(`INSERT INTO advert_skills
      (reference, ordinal, skill_id, keyword, weight, target_years) VALUES (?, ?, ?, ?, ?, ?)`);
    schema.skills.forEach((s, ordinal) => {
      skill.run(reference, ordinal, s.skillId, s.keyword, s.weight, s.targetYears);
    });
  }

  /** Persist a kernel receipt with its inputs. Applications are write-once. */
  commitApplication(input: ApplicationCommit, context: CommitContext): ApplicationAcknowledgement {
    const { receipt, submission } = input;
    if (receipt.evidence.reference !== input.reference) throw new StoreError("workflow-reference-mismatch");
    return this.transaction(() => {
      const prior = this.idempotencyPayload(context);
      if (prior !== null) return parseStoredAcknowledgement(prior);

      const advertised = this.get(context.tenantId, input.reference);
      if (advertised === null) throw new StoreError("not-found");
      if (advertised.stage !== "advertising") throw new StoreError("advert-closed");
      try {
        this.database
          .prepare(`INSERT INTO applications
            (reference, application_id, tenant_id, candidate_actor, candidate_name, cv_locator,
             cv_version, cv_text, consented_at, keywords, experience, screening, completeness, total,
             policy_version, evidence_actor, evidence_tick, evidence_revision, evidence_detail, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            input.reference,
            receipt.applicationId,
            context.tenantId,
            context.actor,
            submission.candidateName,
            input.cv.locator,
            input.cv.version,
            submission.cvText,
            receipt.evidence.tick,
            receipt.breakdown.keywords,
            receipt.breakdown.experience,
            receipt.breakdown.screening,
            receipt.breakdown.completeness,
            receipt.total,
            receipt.policyVersion,
            receipt.evidence.actor,
            receipt.evidence.tick,
            receipt.evidence.revision,
            receipt.evidence.detail,
            Date.now()
          );
      } catch (error) {
        if (isUniqueViolation(error)) throw new StoreError("already-applied");
        throw error;
      }
      const answer = this.database.prepare(`INSERT INTO application_answers
        (reference, application_id, ordinal, question_id, answer) VALUES (?, ?, ?, ?, ?)`);
      submission.answers.forEach((a, ordinal) => {
        answer.run(input.reference, receipt.applicationId, ordinal, a.questionId, a.answer);
      });
      const experience = this.database.prepare(`INSERT INTO application_experience
        (reference, application_id, ordinal, skill_id, years) VALUES (?, ?, ?, ?, ?)`);
      submission.years.forEach((y, ordinal) => {
        experience.run(input.reference, receipt.applicationId, ordinal, y.skillId, y.years);
      });
      const response: ApplicationAcknowledgement = {
        reference: input.reference,
        applicationId: receipt.applicationId,
        status: "received"
      };
      this.recordIdempotency(context, response);
      return response;
    });
  }

  /** Candidate view: advertised roles without expected answers, weights or budget. */
  openAdverts(tenantId: string, candidateActor: string): OpenAdvert[] {
    const rows = this.database
      .prepare(`SELECT * FROM requisitions WHERE tenant_id = ? AND stage = 'advertising'
        ORDER BY reference DESC`)
      .all(tenantId) as Row[];
    const schemas = this.schemas(
      "JOIN requisitions ON requisitions.reference = child.reference WHERE requisitions.tenant_id = ?",
      [tenantId]
    );
    const applied = new Set(
      (
        this.database
          .prepare("SELECT reference FROM applications WHERE tenant_id = ? AND candidate_actor = ?")
          .all(tenantId, candidateActor) as Row[]
      ).map((row) => natural(row.reference))
    );
    return rows.map((row) => {
      const reference = natural(row.reference);
      const schema = schemas.get(reference) ?? { questions: [], skills: [] };
      return {
        reference,
        role: requiredString(row.role),
        department: requiredString(row.department),
        questions: schema.questions.map(({ questionId, prompt }) => ({ questionId, prompt })),
        skills: schema.skills.map(({ skillId, keyword }) => ({ skillId, keyword })),
        applied: applied.has(reference)
      };
    });
  }

  /** Recruiter view: every application with its answers, experience and score workings. */
  applications(tenantId: string, reference: number): ApplicationRecord[] {
    const advertised = this.get(tenantId, reference);
    if (advertised?.advert === null || advertised === null) return [];
    const schema = advertised.advert;
    const rows = this.database
      .prepare(`SELECT * FROM applications WHERE tenant_id = ? AND reference = ?
        ORDER BY total DESC, application_id`)
      .all(tenantId, reference) as Row[];
    const answers = this.database.prepare(`SELECT * FROM application_answers
      WHERE reference = ? AND application_id = ? ORDER BY ordinal`);
    const years = this.database.prepare(`SELECT * FROM application_experience
      WHERE reference = ? AND application_id = ? ORDER BY ordinal`);
    return rows.map((row) => {
      const applicationId = natural(row.application_id);
      return {
        reference,
        applicationId,
        candidateName: requiredString(row.candidate_name),
        candidateActor: requiredString(row.candidate_actor),
        cvVersion: requiredString(row.cv_version),
        cvText: text(row.cv_text),
        answers: (answers.all(reference, applicationId) as Row[]).map((entry) => {
          const question = schema.questions.find((q) => q.questionId === natural(entry.question_id));
          if (question === undefined) throw new StoreError("invalid-stored-state");
          return { ...question, answer: text(entry.answer) };
        }),
        experience: (years.all(reference, applicationId) as Row[]).map((entry) => {
          const skill = schema.skills.find((s) => s.skillId === natural(entry.skill_id));
          if (skill === undefined) throw new StoreError("invalid-stored-state");
          return { ...skill, years: natural(entry.years) };
        }),
        breakdown: {
          keywords: natural(row.keywords),
          experience: natural(row.experience),
          screening: natural(row.screening),
          completeness: natural(row.completeness)
        },
        total: natural(row.total),
        policyVersion: requiredString(row.policy_version),
        evidence: {
          event: "application-scored",
          actor: requiredString(row.evidence_actor),
          tick: natural(row.evidence_tick),
          reference,
          revision: natural(row.evidence_revision),
          detail: requiredString(row.evidence_detail)
        },
        createdAt: natural(row.created_at)
      };
    });
  }
}
