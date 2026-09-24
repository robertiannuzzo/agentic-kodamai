import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AdvertSchema,
  ApplicationAcknowledgement,
  ApplicationReview,
  ApplicationRecord,
  ApplicationSubmission,
  AuditEntry,
  EmployeeRecord,
  OpenAdvert,
  RequisitionCase,
  RequisitionStage,
  ScoreBreakdown,
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

export interface ReviewCommit {
  reference: number;
  applicationId: number;
  disposition: ApplicationReview["disposition"];
  reason: string;
  note: string;
  evidence: AuditEntry;
}

/** Everything the kernel needs to re-derive a stored score. */
export interface StoredApplication {
  reference: number;
  applicationId: number;
  candidateActor: string;
  cv: { locator: string; version: string; text: string };
  answers: Array<{ questionId: number; answer: string }>;
  years: Array<{ skillId: number; years: number }>;
  breakdown: ScoreBreakdown;
  evidence: AuditEntry;
  erasedAt: number | null;
  reviewed: boolean;
  review: { disposition: "shortlist" | "reject"; evidence: AuditEntry } | null;
  employeeId: number | null;
}

export interface HireCommit {
  reference: number;
  applicationId: number;
  legalName: string;
  startTick: number;
  evidence: AuditEntry;
}

export const ERASED_NAME = "Erased candidate";

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
    advert: advert ?? null,
    hired: natural(row.hired ?? 0)
  };
}

function parseStoredReview(payload: string): ApplicationReview {
  const row = parseJson(payload);
  const evidence = row.evidence as Row | undefined;
  if (
    (row.disposition !== "shortlist" && row.disposition !== "reject") ||
    evidence === undefined ||
    typeof evidence !== "object"
  ) {
    throw new StoreError("invalid-stored-idempotency-response");
  }
  return {
    reference: natural(row.reference),
    applicationId: natural(row.applicationId),
    disposition: row.disposition,
    reason: text(row.reason),
    note: text(row.note),
    evidence: auditEntry(evidence, natural(evidence.reference))
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
  const { tenantId: _tenantId, requesterId: _requesterId, hired: _hired, ...result } = row;
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
    const hires = new Map<number, number>();
    for (const row of this.database
      .prepare(`SELECT child.reference, COUNT(*) AS hired FROM employees AS child ${scope}
        GROUP BY child.reference`)
      .all(...parameters) as Row[]) {
      hires.set(natural(row.reference), natural(row.hired));
    }
    return rows.map((row) => {
      const reference = natural(row.reference);
      return this.rowToCase(row, histories.get(reference) ?? [], schemas.get(reference) ?? null, hires.get(reference) ?? 0);
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
    return this.rowToCase(row, history, schemas.get(reference) ?? null, this.hiredCount(reference));
  }

  hiredCount(reference: number): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS hired FROM employees WHERE reference = ?")
      .get(reference) as Row;
    return natural(row.hired);
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

  private rowToCase(row: Row, history: AuditEntry[], advert: AdvertSchema | null, hired: number): RequisitionCase {
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
      advert,
      hired
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

      const response: RequisitionCase = {
        ...result,
        tenantId: context.tenantId,
        requesterId,
        hired: this.hiredCount(result.reference)
      };
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
      if (advertised.stage !== "advertising" || advertised.hired >= advertised.headcount) {
        throw new StoreError("advert-closed");
      }
      try {
        this.database
          .prepare(`INSERT INTO applications
            (reference, application_id, tenant_id, candidate_actor, candidate_name, cv_locator,
             cv_version, cv_text, notice_acknowledged_at, keywords, experience, screening, completeness, total,
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

  applicationReviewIdempotencyResult(context: CommitContext): ApplicationReview | null {
    const payload = this.idempotencyPayload(context);
    return payload === null ? null : parseStoredReview(payload);
  }

  storedApplication(tenantId: string, reference: number, applicationId: number): StoredApplication | null {
    const row = this.database
      .prepare("SELECT * FROM applications WHERE tenant_id = ? AND reference = ? AND application_id = ?")
      .get(tenantId, reference, applicationId) as Row | undefined;
    if (row === undefined) return null;
    const reviewRow = this.database
      .prepare("SELECT * FROM application_reviews WHERE reference = ? AND application_id = ?")
      .get(reference, applicationId) as Row | undefined;
    const review = this.review(reviewRow, reference, applicationId);
    const employee = this.database
      .prepare("SELECT employee_id FROM employees WHERE reference = ? AND application_id = ?")
      .get(reference, applicationId) as Row | undefined;
    return {
      reference,
      applicationId,
      candidateActor: requiredString(row.candidate_actor),
      cv: {
        locator: requiredString(row.cv_locator),
        version: requiredString(row.cv_version),
        text: text(row.cv_text)
      },
      answers: (
        this.database
          .prepare(`SELECT question_id, answer FROM application_answers
            WHERE reference = ? AND application_id = ? ORDER BY ordinal`)
          .all(reference, applicationId) as Row[]
      ).map((entry) => ({ questionId: natural(entry.question_id), answer: text(entry.answer) })),
      years: (
        this.database
          .prepare(`SELECT skill_id, years FROM application_experience
            WHERE reference = ? AND application_id = ? ORDER BY ordinal`)
          .all(reference, applicationId) as Row[]
      ).map((entry) => ({ skillId: natural(entry.skill_id), years: natural(entry.years) })),
      breakdown: {
        keywords: natural(row.keywords),
        experience: natural(row.experience),
        screening: natural(row.screening),
        completeness: natural(row.completeness)
      },
      evidence: {
        event: "application-scored",
        actor: requiredString(row.evidence_actor),
        tick: natural(row.evidence_tick),
        reference,
        revision: natural(row.evidence_revision),
        detail: requiredString(row.evidence_detail)
      },
      erasedAt: row.erased_at === null ? null : natural(row.erased_at),
      reviewed: review !== null,
      review: review === null ? null : { disposition: review.disposition, evidence: review.evidence },
      employeeId: employee === undefined ? null : natural(employee.employee_id)
    };
  }

  /** Record a kernel-produced review. One decision per application. */
  commitReview(input: ReviewCommit, context: CommitContext): ApplicationReview {
    return this.transaction(() => {
      const prior = this.idempotencyPayload(context);
      if (prior !== null) return parseStoredReview(prior);
      const stored = this.storedApplication(context.tenantId, input.reference, input.applicationId);
      if (stored === null) throw new StoreError("not-found");
      if (stored.erasedAt !== null) throw new StoreError("application-erased");
      try {
        this.database
          .prepare(`INSERT INTO application_reviews
            (reference, application_id, disposition, reason, note, reviewer, tick, revision, detail, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            input.reference,
            input.applicationId,
            input.disposition,
            input.reason,
            input.note,
            input.evidence.actor,
            input.evidence.tick,
            input.evidence.revision,
            input.evidence.detail,
            Date.now()
          );
      } catch (error) {
        if (isUniqueViolation(error)) throw new StoreError("already-reviewed");
        throw error;
      }
      const response: ApplicationReview = { ...input };
      this.recordIdempotency(context, response);
      return response;
    });
  }

  /**
   * Remove personal data from one application: name, contact identity, CV text,
   * free-text answers and review notes. Scores and evidence remain, so the
   * record of what was decided survives without identifying the person.
   */
  private eraseRow(reference: number, applicationId: number, reason: string, now: number): void {
    const erased = this.database
      .prepare(`UPDATE applications
        SET candidate_name = ?, candidate_actor = 'erased:' || reference || ':' || application_id,
            evidence_actor = 'erased:' || reference || ':' || application_id,
            cv_text = '', cv_version = 'erased', erased_at = ?, erasure_reason = ?
        WHERE reference = ? AND application_id = ? AND erased_at IS NULL`)
      .run(ERASED_NAME, now, reason, reference, applicationId);
    if (Number(erased.changes) === 0) return;
    this.database
      .prepare("UPDATE application_answers SET answer = '' WHERE reference = ? AND application_id = ?")
      .run(reference, applicationId);
    this.database
      .prepare(`UPDATE application_reviews SET reason = '', note = ''
        WHERE reference = ? AND application_id = ?`)
      .run(reference, applicationId);
  }

  eraseApplication(tenantId: string, reference: number, applicationId: number, reason: string, now: number): boolean {
    return this.transaction(() => {
      const row = this.database
        .prepare(`SELECT candidate_actor, erased_at FROM applications
          WHERE tenant_id = ? AND reference = ? AND application_id = ?`)
        .get(tenantId, reference, applicationId) as Row | undefined;
      if (row === undefined) return false;
      this.forgetIdempotency(tenantId, requiredString(row.candidate_actor), reference);
      this.eraseRow(reference, applicationId, reason, now);
      return true;
    });
  }

  /** A candidate withdraws: erase their own application to this advert. */
  eraseCandidateApplication(tenantId: string, reference: number, candidateActor: string, now: number): boolean {
    return this.transaction(() => {
      const row = this.database
        .prepare(`SELECT application_id FROM applications
          WHERE tenant_id = ? AND reference = ? AND candidate_actor = ? AND erased_at IS NULL`)
        .get(tenantId, reference, candidateActor) as Row | undefined;
      if (row === undefined) return false;
      this.forgetIdempotency(tenantId, candidateActor, reference);
      this.eraseRow(reference, natural(row.application_id), "withdrawn by candidate", now);
      return true;
    });
  }

  /** Idempotency keys are scoped by actor, which for a candidate is personal data. */
  private forgetIdempotency(tenantId: string, candidateActor: string, reference: number): void {
    this.database
      .prepare("DELETE FROM idempotency_records WHERE tenant_id = ? AND actor = ? AND operation = ?")
      .run(tenantId, candidateActor, `apply:${reference}`);
  }

  /** Anonymise applications older than the retention period. */
  purgeExpiredApplications(now: number, retentionMs: number): number {
    return this.transaction(() => {
      const expired = this.database
        .prepare(`SELECT tenant_id, reference, application_id, candidate_actor FROM applications
          WHERE erased_at IS NULL AND created_at < ?`)
        .all(now - retentionMs) as Row[];
      for (const row of expired) {
        const reference = natural(row.reference);
        this.forgetIdempotency(requiredString(row.tenant_id), requiredString(row.candidate_actor), reference);
        this.eraseRow(reference, natural(row.application_id), "retention period ended", now);
      }
      return expired.length;
    });
  }

  /** Retries are only honoured within the window; older keys are forgotten. */
  pruneIdempotency(now: number, ttlMs: number): number {
    const result = this.database
      .prepare("DELETE FROM idempotency_records WHERE created_at < ?")
      .run(now - ttlMs);
    return Number(result.changes);
  }

  hireIdempotencyResult(context: CommitContext): EmployeeRecord | null {
    const payload = this.idempotencyPayload(context);
    return payload === null ? null : (JSON.parse(payload) as EmployeeRecord);
  }

  /** Create the people record for a kernel-approved hire. */
  commitHire(input: HireCommit, context: CommitContext): EmployeeRecord {
    return this.transaction(() => {
      const prior = this.idempotencyPayload(context);
      if (prior !== null) return JSON.parse(prior) as EmployeeRecord;
      const advertised = this.get(context.tenantId, input.reference);
      if (advertised === null) throw new StoreError("not-found");
      if (advertised.hired >= advertised.headcount) throw new StoreError("requisition-filled");
      const stored = this.storedApplication(context.tenantId, input.reference, input.applicationId);
      if (stored === null) throw new StoreError("not-found");
      if (stored.erasedAt !== null) throw new StoreError("application-erased");
      if (stored.review?.disposition !== "shortlist") throw new StoreError("not-shortlisted");
      let employeeId: number;
      try {
        const inserted = this.database
          .prepare(`INSERT INTO employees
            (tenant_id, reference, application_id, legal_name, start_tick, hired_by, hired_tick,
             evidence_revision, evidence_detail, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            context.tenantId,
            input.reference,
            input.applicationId,
            input.legalName,
            input.startTick,
            input.evidence.actor,
            input.evidence.tick,
            input.evidence.revision,
            input.evidence.detail,
            Date.now()
          );
        employeeId = Number(inserted.lastInsertRowid);
      } catch (error) {
        if (isUniqueViolation(error)) throw new StoreError("already-hired");
        throw error;
      }
      const response = this.employees(context.tenantId).find((e) => e.employeeId === employeeId);
      if (response === undefined) throw new StoreError("invalid-stored-state");
      this.recordIdempotency(context, response);
      return response;
    });
  }

  /** People records, each with the application and decisions it came from. */
  employees(tenantId: string, reference?: number): EmployeeRecord[] {
    const rows = this.database
      .prepare(`SELECT employees.*, requisitions.role, requisitions.department,
          applications.total, applications.policy_version, applications.evidence_actor,
          applications.evidence_tick, applications.evidence_revision, applications.evidence_detail AS scoring_detail,
          application_reviews.reviewer, application_reviews.tick AS review_tick,
          application_reviews.revision AS review_revision, application_reviews.detail AS review_detail
        FROM employees
        JOIN requisitions ON requisitions.reference = employees.reference
        JOIN applications ON applications.reference = employees.reference
          AND applications.application_id = employees.application_id
        JOIN application_reviews ON application_reviews.reference = employees.reference
          AND application_reviews.application_id = employees.application_id
        WHERE employees.tenant_id = ?${reference === undefined ? "" : " AND employees.reference = ?"}
        ORDER BY employees.employee_id`)
      .all(...(reference === undefined ? [tenantId] : [tenantId, reference])) as Row[];
    return rows.map((row) => {
      const ref = natural(row.reference);
      return {
        employeeId: natural(row.employee_id),
        legalName: requiredString(row.legal_name),
        startDate: new Date(natural(row.start_tick)).toISOString().slice(0, 10),
        role: requiredString(row.role),
        department: requiredString(row.department),
        provenance: {
          reference: ref,
          applicationId: natural(row.application_id),
          total: natural(row.total),
          policyVersion: requiredString(row.policy_version),
          scoring: {
            event: "application-scored",
            actor: requiredString(row.evidence_actor),
            tick: natural(row.evidence_tick),
            reference: ref,
            revision: natural(row.evidence_revision),
            detail: requiredString(row.scoring_detail)
          },
          shortlist: {
            event: "application-reviewed",
            actor: requiredString(row.reviewer),
            tick: natural(row.review_tick),
            reference: ref,
            revision: natural(row.review_revision),
            detail: requiredString(row.review_detail)
          }
        },
        evidence: {
          event: "hired",
          actor: requiredString(row.hired_by),
          tick: natural(row.hired_tick),
          reference: ref,
          revision: natural(row.evidence_revision),
          detail: requiredString(row.evidence_detail)
        }
      };
    });
  }

  /** Candidate view: advertised roles without expected answers, weights or budget. */
  openAdverts(tenantId: string, candidateActor: string, retentionDays = 180): OpenAdvert[] {
    const rows = this.database
      .prepare(`SELECT * FROM requisitions WHERE tenant_id = ? AND stage = 'advertising'
          AND ((SELECT COUNT(*) FROM employees WHERE employees.reference = requisitions.reference) < headcount
            -- A filled advert stays visible to its applicants so they can still withdraw.
            OR EXISTS (SELECT 1 FROM applications WHERE applications.reference = requisitions.reference
              AND applications.candidate_actor = ? AND applications.erased_at IS NULL))
        ORDER BY reference DESC`)
      .all(tenantId, candidateActor) as Row[];
    const schemas = this.schemas(
      "JOIN requisitions ON requisitions.reference = child.reference WHERE requisitions.tenant_id = ?",
      [tenantId]
    );
    const applied = new Set(
      (
        this.database
          .prepare(`SELECT reference FROM applications
            WHERE tenant_id = ? AND candidate_actor = ? AND erased_at IS NULL`)
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
        applied: applied.has(reference),
        retentionDays
      };
    });
  }

  private review(row: Row | undefined, reference: number, applicationId: number): ApplicationReview | null {
    if (row === undefined) return null;
    const disposition = row.disposition;
    if (disposition !== "shortlist" && disposition !== "reject") throw new StoreError("invalid-stored-state");
    return {
      reference,
      applicationId,
      disposition,
      reason: text(row.reason),
      note: text(row.note),
      evidence: {
        event: "application-reviewed",
        actor: requiredString(row.reviewer),
        tick: natural(row.tick),
        reference,
        revision: natural(row.revision),
        detail: requiredString(row.detail)
      }
    };
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
    const reviews = this.database.prepare(`SELECT * FROM application_reviews
      WHERE reference = ? AND application_id = ?`);
    const employeeIds = new Map(
      (
        this.database
          .prepare("SELECT application_id, employee_id FROM employees WHERE reference = ?")
          .all(reference) as Row[]
      ).map((row) => [natural(row.application_id), natural(row.employee_id)] as const)
    );
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
        createdAt: natural(row.created_at),
        review: this.review(reviews.get(reference, applicationId) as Row | undefined, reference, applicationId),
        erasedAt: row.erased_at === null ? null : natural(row.erased_at),
        erasureReason: row.erasure_reason === null ? null : text(row.erasure_reason),
        employeeId: employeeIds.get(applicationId) ?? null
      };
    });
  }
}
