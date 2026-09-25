import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import type {
  AdvertQuestion,
  AdvertSkill,
  ApiError,
  ApplicationAcknowledgement,
  ApplicationReview,
  ApplicationSubmission,
  DemoRole,
  EmployeeRecord,
  RequisitionCase,
  RequisitionFields,
  ReviewDecision,
  WorkflowCommand
} from "../../../packages/contracts/src/index.js";
import {
  RecruitmentStore,
  StoreError,
  workflowCase,
  type CommitContext
} from "./store.js";
import { WorkflowClient, WorkflowError } from "./workflow.js";

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
    this.name = "HttpError";
  }
}

interface Identity {
  actor: string;
  role: DemoRole;
  tenantId: string;
}

interface Transition {
  current: RequisitionCase | null;
  command: WorkflowCommand;
}

export interface ApplicationOptions {
  databasePath: string;
  workflowExecutable?: string;
  webRoot?: string;
  log?: (record: Record<string, string | number>) => void;
  /** Applications are anonymised this many days after they are received. */
  retentionDays?: number;
  /** Retries are deduplicated within this window (Stripe uses 24 hours). */
  idempotencyTtlMs?: number;
  /** How often retention and idempotency maintenance runs; 0 disables the timer. */
  maintenanceIntervalMs?: number;
  /** Public application endpoint limits per candidate and per client address. */
  applyRateLimit?: { perCandidate: number; perAddress: number; windowMs: number };
}

export interface Application {
  server: Server;
  store: RecruitmentStore;
  /** Run retention and idempotency maintenance now. */
  maintain(now?: number): { purged: number; pruned: number };
  close(): Promise<void>;
}

const day = 24 * 60 * 60 * 1000;

/** A small fixed-window limiter; state is per process, which suits one instance. */
class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  allow(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((time) => time > now - this.windowMs);
    const allowed = recent.length < this.limit;
    if (allowed) recent.push(now);
    this.hits.set(key, recent);
    return allowed;
  }

  prune(now: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((time) => time <= now - this.windowMs)) this.hits.delete(key);
    }
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

function header(request: IncomingMessage, name: string, error: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || value.trim() === "") throw new HttpError(401, error);
  return value.trim();
}

function identity(request: IncomingMessage): Identity {
  const actor = header(request, "x-demo-actor", "identity-required");
  const tenantId = header(request, "x-demo-tenant", "tenant-required");
  const role = request.headers["x-demo-role"];
  if (role !== "requester" && role !== "approver" && role !== "recruiter" && role !== "candidate") {
    throw new HttpError(401, "role-required");
  }
  return { actor, role, tenantId };
}

function idempotencyKey(request: IncomingMessage): string {
  const value = request.headers["idempotency-key"];
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 200 ||
    !/^[A-Za-z0-9._:-]+$/u.test(value)
  ) {
    throw new HttpError(400, "idempotency-key-required");
  }
  return value;
}

function requireRole(actual: DemoRole, expected: DemoRole): void {
  if (actual !== expected) throw new HttpError(403, `${expected}-role-required`);
}

function requireStaff(actual: DemoRole): void {
  if (actual === "candidate") throw new HttpError(403, "staff-role-required");
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "json-content-type-required");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new HttpError(413, "request-too-large");
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("object required");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid-json");
  }
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new HttpError(400, `invalid-${field}`);
  return Number(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new HttpError(400, `invalid-${field}`);
  return value;
}

function fields(value: unknown): RequisitionFields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "invalid-fields");
  }
  const record = value as Record<string, unknown>;
  return {
    role: text(record.role, "role"),
    department: text(record.department, "department"),
    headcount: integer(record.headcount, "headcount"),
    budgetMinor: integer(record.budgetMinor, "budget"),
    justification: text(record.justification, "justification")
  };
}

function boundedText(value: unknown, field: string, maximum: number): string {
  const result = text(value, field);
  if (result.trim() === "" || Array.from(result).length > maximum) throw new HttpError(400, `invalid-${field}`);
  return result;
}

function list(value: unknown, field: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new HttpError(400, `invalid-${field}`);
  }
  return value;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, `invalid-${field}`);
  }
  return value as Record<string, unknown>;
}

/** Identifiers are assigned by position; the frozen order is part of the advert. */
function advertSchema(input: Record<string, unknown>): { questions: AdvertQuestion[]; skills: AdvertSkill[] } {
  return {
    questions: list(input.questions, "questions", 20).map((value, index) => {
      const q = record(value, "question");
      return {
        questionId: index + 1,
        prompt: boundedText(q.prompt, "question", 500),
        expected: boundedText(q.expected, "expected-answer", 200)
      };
    }),
    skills: list(input.skills, "skills", 20).map((value, index) => {
      const s = record(value, "skill");
      return {
        skillId: index + 1,
        keyword: boundedText(s.keyword, "skill", 100),
        weight: integer(s.weight, "weight"),
        targetYears: integer(s.targetYears, "target-years")
      };
    })
  };
}

function submission(input: Record<string, unknown>): ApplicationSubmission {
  if (input.acknowledgedPrivacyNotice !== true) throw new HttpError(400, "privacy-notice-required");
  return {
    candidateName: boundedText(input.candidateName, "candidate-name", 200),
    cvText: boundedText(input.cvText, "cv-text", 50_000),
    acknowledgedPrivacyNotice: true,
    answers: list(input.answers, "answers", 20).map((value) => {
      const a = record(value, "answer");
      return { questionId: integer(a.questionId, "question-id"), answer: text(a.answer, "answer") };
    }),
    years: list(input.years, "years", 20).map((value) => {
      const y = record(value, "years");
      return { skillId: integer(y.skillId, "skill-id"), years: integer(y.years, "years") };
    })
  };
}

/** A real calendar date as UTC midnight; JavaScript would roll 2026-02-31 into March. */
function calendarDate(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  const [year, month, day] = [Number(match?.[1]), Number(match?.[2]), Number(match?.[3])];
  const tick = Date.UTC(year, month - 1, day);
  const date = new Date(tick);
  if (
    match === null ||
    Number.isNaN(tick) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new HttpError(400, "invalid-start-date");
  }
  return tick;
}

function advertApplicationsReference(pathname: string): number | null {
  const match = /^\/api\/adverts\/(\d+)\/applications$/u.exec(pathname);
  if (match?.[1] === undefined) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function applicationAction(pathname: string): { reference: number; applicationId: number; action: string } | null {
  const match = /^\/api\/requisitions\/(\d+)\/applications\/(\d+)\/(review|erase|hire)$/u.exec(pathname);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return null;
  const reference = Number(match[1]);
  const applicationId = Number(match[2]);
  if (!Number.isSafeInteger(reference) || !Number.isSafeInteger(applicationId)) return null;
  return { reference, applicationId, action: match[3] };
}

function withdrawalReference(pathname: string): number | null {
  const match = /^\/api\/adverts\/(\d+)\/applications\/mine$/u.exec(pathname);
  if (match?.[1] === undefined) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function pathReference(pathname: string): number | null {
  const match = /^\/api\/requisitions\/(\d+)(?:\/.*)?$/u.exec(pathname);
  if (match?.[1] === undefined) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function stableValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`)
    .join(",")}}`;
}

function fingerprint(operation: string, input: unknown): string {
  return createHash("sha256").update(stableValue({ operation, input })).digest("hex");
}

function mapError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof StoreError) {
    if (
      error.code === "stale-version" ||
      error.code === "audit-history-mismatch" ||
      error.code === "idempotency-key-conflict" ||
      error.code === "already-applied" ||
      error.code === "advert-closed" ||
      error.code === "already-reviewed" ||
      error.code === "application-erased" ||
      error.code === "not-shortlisted" ||
      error.code === "requisition-filled" ||
      error.code === "already-hired"
    ) {
      return new HttpError(409, error.code);
    }
    if (error.code === "not-found") return new HttpError(404, error.code);
    return new HttpError(500, "internal-server-error");
  }
  const code = error instanceof WorkflowError ? error.code : "internal-server-error";
  if (code === "not-found") return new HttpError(404, code);
  if (code === "not-shortlisted") return new HttpError(409, code);
  if (code === "self-review-forbidden") return new HttpError(403, code);
  if (code === "stale-version" || code === "wrong-stage") {
    return new HttpError(409, code);
  }
  if (
    code.startsWith("invalid-field:") ||
    code === "invalid-reference" ||
    code.startsWith("invalid-schema:") ||
    code === "reason-required" ||
    code === "answers-do-not-match-questions" ||
    code === "experience-does-not-match-skills" ||
    code === "invalid-cv-reference" ||
    code === "identity-required" ||
    code === "tenant-required" ||
    code === "role-required"
  ) {
    return new HttpError(400, code);
  }
  return new HttpError(500, "internal-server-error");
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".woff2":
      return "font/woff2";
    case ".woff":
      return "font/woff";
    default:
      return "application/octet-stream";
  }
}

function serveWeb(pathname: string, webRoot: string, response: ServerResponse): boolean {
  const root = resolve(webRoot);
  const relative = pathname === "/" ? "index.html" : normalize(pathname).replace(/^[/\\]+/u, "");
  let candidate = resolve(join(root, relative));
  if (!candidate.startsWith(`${root}/`) && candidate !== root) return false;
  if (!existsSync(candidate) || !statSync(candidate).isFile()) candidate = join(root, "index.html");
  if (!existsSync(candidate)) return false;
  response.writeHead(200, {
    "content-type": contentType(candidate),
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'"
  });
  createReadStream(candidate).pipe(response);
  return true;
}

export async function createApplication(options: ApplicationOptions): Promise<Application> {
  const store = new RecruitmentStore(options.databasePath);
  const workflow = new WorkflowClient(options.workflowExecutable);
  const retentionDays = options.retentionDays ?? 180;
  const idempotencyTtlMs = options.idempotencyTtlMs ?? day;
  const limits = options.applyRateLimit ?? { perCandidate: 5, perAddress: 30, windowMs: 10 * 60 * 1000 };
  const candidateLimiter = new RateLimiter(limits.perCandidate, limits.windowMs);
  const addressLimiter = new RateLimiter(limits.perAddress, limits.windowMs);

  function maintain(now = Date.now()): { purged: number; pruned: number } {
    const purged = store.purgeExpiredApplications(now, retentionDays * day);
    const pruned = store.pruneIdempotency(now, idempotencyTtlMs);
    candidateLimiter.prune(now);
    addressLimiter.prune(now);
    if (purged > 0 || pruned > 0) options.log?.({ event: "maintenance", purged, pruned });
    return { purged, pruned };
  }
  maintain();
  const interval = options.maintenanceIntervalMs ?? 60 * 60 * 1000;
  const timer = interval > 0 ? setInterval(() => maintain(), interval) : null;
  timer?.unref();

  let mutationTail: Promise<void> = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async function mutate(
    user: Identity,
    key: string,
    operation: string,
    input: unknown,
    transition: () => Transition
  ): Promise<RequisitionCase> {
    const context: CommitContext = {
      tenantId: user.tenantId,
      actor: user.actor,
      idempotencyKey: key,
      operation,
      requestFingerprint: fingerprint(operation, input)
    };
    return serialize(async () => {
      const prior = store.idempotencyResult(context);
      if (prior !== null) return prior;
      const proposed = transition();
      const result = await workflow.evaluate(
        proposed.current === null ? null : workflowCase(proposed.current),
        proposed.command
      );
      return store.commit(proposed.command, result.result, context);
    });
  }

  /**
   * A candidate application: the kernel's intake branch validates it, reads the
   * stored CV through the extraction leaf, builds the advert-indexed
   * application and scores it. Only then is anything persisted.
   */
  async function apply(
    request: IncomingMessage,
    user: Identity,
    key: string,
    reference: number,
    input: Record<string, unknown>
  ): Promise<ApplicationAcknowledgement> {
    const context: CommitContext = {
      tenantId: user.tenantId,
      actor: user.actor,
      idempotencyKey: key,
      operation: `apply:${reference}`,
      requestFingerprint: fingerprint(`apply:${reference}`, input)
    };
    const application = submission(input);
    // A retry of a request that already succeeded replays its stored response
    // and must not spend rate-limit capacity or be refused by it.
    const replayed = store.applicationIdempotencyResult(context);
    if (replayed !== null) return replayed;
    const address = request.socket.remoteAddress ?? "unknown";
    return serialize(async () => {
      // Re-check inside the serialised section: a concurrent duplicate of this
      // request may have completed while this one waited, and it must replay
      // rather than spend (or be refused by) rate-limit capacity.
      const prior = store.applicationIdempotencyResult(context);
      if (prior !== null) return prior;
      const now = Date.now();
      if (
        !candidateLimiter.allow(`${user.tenantId}:${user.actor}`, now) ||
        !addressLimiter.allow(address, now)
      ) {
        throw new HttpError(429, "rate-limited");
      }
      const advertised = store.get(user.tenantId, reference);
      if (advertised === null || advertised.stage !== "advertising") throw new HttpError(404, "not-found");
      if (store.openAdverts(user.tenantId, user.actor).some((advert) => advert.reference === reference && advert.applied)) {
        throw new HttpError(409, "already-applied");
      }
      const applicationId = store.allocateApplicationId(reference);
      const cv = {
        locator: `cv://${user.tenantId}/${reference}/${applicationId}`,
        version: createHash("sha256").update(application.cvText).digest("hex")
      };
      const receipt = await workflow.intake(workflowCase(advertised), {
        applicationId,
        actor: user.actor,
        tick: Date.now(),
        cv: { ...cv, text: application.cvText },
        answers: application.answers,
        years: application.years
      });
      return store.commitApplication({ reference, submission: application, cv, receipt }, context);
    });
  }

  /**
   * A recruiter's decision. The kernel's assess branch re-derives the score from
   * the stored inputs through the intake chain, refuses if it no longer matches
   * what was stored, and only then produces review evidence indexed by it.
   */
  async function reviewApplication(
    user: Identity,
    key: string,
    reference: number,
    applicationId: number,
    input: Record<string, unknown>
  ): Promise<ApplicationReview> {
    const disposition = text(input.disposition, "disposition");
    if (disposition !== "shortlist" && disposition !== "reject") throw new HttpError(400, "invalid-disposition");
    const reason = text(input.reason ?? "", "reason");
    const note = text(input.note ?? "", "note");
    if (Array.from(reason).length > 2000 || Array.from(note).length > 5000) throw new HttpError(400, "invalid-note");
    const operation = `review-application:${reference}:${applicationId}`;
    const context: CommitContext = {
      tenantId: user.tenantId,
      actor: user.actor,
      idempotencyKey: key,
      operation,
      requestFingerprint: fingerprint(operation, input)
    };
    return serialize(async () => {
      const prior = store.applicationReviewIdempotencyResult(context);
      if (prior !== null) return prior;
      const advertised = accessible(user, reference, false);
      const stored = store.storedApplication(user.tenantId, reference, applicationId);
      if (stored === null) throw new HttpError(404, "not-found");
      if (stored.erasedAt !== null) throw new HttpError(409, "application-erased");
      if (stored.reviewed) throw new HttpError(409, "already-reviewed");
      const outcome = await workflow.assess(workflowCase(advertised), {
        application: {
          applicationId,
          actor: stored.evidence.actor,
          tick: stored.evidence.tick,
          cv: stored.cv,
          answers: stored.answers,
          years: stored.years
        },
        stored: { breakdown: stored.breakdown, evidence: stored.evidence },
        reviewer: user.actor,
        tick: Date.now(),
        disposition,
        reason
      });
      return store.commitReview(
        { reference, applicationId, disposition: outcome.disposition, reason, note, evidence: outcome.evidence },
        context
      );
    });
  }

  /**
   * Hire one shortlisted application. The kernel's hire branch re-derives the
   * score, re-makes the recorded shortlist and only then runs the hire link,
   * whose reply includes proof that the employee came from this application.
   */
  async function hireApplication(
    user: Identity,
    key: string,
    reference: number,
    applicationId: number,
    input: Record<string, unknown>
  ): Promise<EmployeeRecord> {
    const legalName = boundedText(input.legalName, "legal-name", 200);
    const startTick = calendarDate(text(input.startDate, "start-date"));
    const operation = `hire:${reference}:${applicationId}`;
    const context: CommitContext = {
      tenantId: user.tenantId,
      actor: user.actor,
      idempotencyKey: key,
      operation,
      requestFingerprint: fingerprint(operation, input)
    };
    return serialize(async () => {
      const prior = store.hireIdempotencyResult(context);
      if (prior !== null) return prior;
      const advertised = accessible(user, reference, false);
      const stored = store.storedApplication(user.tenantId, reference, applicationId);
      if (stored === null) throw new HttpError(404, "not-found");
      if (stored.erasedAt !== null) throw new HttpError(409, "application-erased");
      if (stored.review?.disposition !== "shortlist") throw new HttpError(409, "not-shortlisted");
      if (stored.employeeId !== null) throw new HttpError(409, "already-hired");
      if (advertised.hired >= advertised.headcount) throw new HttpError(409, "requisition-filled");
      const hired = await workflow.hire(workflowCase(advertised), {
        assessment: {
          application: {
            applicationId,
            actor: stored.evidence.actor,
            tick: stored.evidence.tick,
            cv: stored.cv,
            answers: stored.answers,
            years: stored.years
          },
          stored: { breakdown: stored.breakdown, evidence: stored.evidence },
          reviewer: stored.review.evidence.actor,
          tick: stored.review.evidence.tick,
          disposition: "shortlist",
          reason: ""
        },
        review: stored.review.evidence,
        hirer: user.actor,
        tick: Date.now(),
        legalName,
        startTick
      });
      if (hired.applicationId !== applicationId || hired.reference !== reference) {
        throw new WorkflowError("workflow-reference-mismatch");
      }
      return store.commitHire(
        { reference, applicationId, legalName: hired.legalName, startTick: hired.startTick, evidence: hired.evidence },
        context
      );
    });
  }

  function accessible(user: Identity, reference: number, ownerRequired: boolean): RequisitionCase {
    const row = store.get(user.tenantId, reference);
    if (row === null) throw new HttpError(404, "not-found");
    if (ownerRequired && row.requesterId !== user.actor) {
      throw new HttpError(404, "not-found");
    }
    return row;
  }

  const server = createServer(async (request, response) => {
    const suppliedRequestId = request.headers["x-request-id"];
    const requestId =
      typeof suppliedRequestId === "string" && /^[A-Za-z0-9._:-]{8,200}$/u.test(suppliedRequestId)
        ? suppliedRequestId
        : randomUUID();
    const startedAt = Date.now();
    response.setHeader("x-request-id", requestId);
    response.once("finish", () => {
      options.log?.({
        event: "http-request",
        requestId,
        method: request.method ?? "UNKNOWN",
        path: request.url ?? "/",
        status: response.statusCode,
        durationMs: Date.now() - startedAt
      });
    });
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/api/")) {
        if (options.webRoot !== undefined && serveWeb(url.pathname, options.webRoot, response)) return;
        throw new HttpError(404, "not-found");
      }

      if (request.method === "GET" && url.pathname === "/api/health") {
        json(response, 200, { status: "ok", workflow: "idris", storage: "sqlite" });
        return;
      }

      const user = identity(request);

      if (request.method === "GET" && url.pathname === "/api/adverts") {
        json(response, 200, store.openAdverts(user.tenantId, user.actor, retentionDays));
        return;
      }

      const applyReference = advertApplicationsReference(url.pathname);
      if (request.method === "POST" && applyReference !== null) {
        requireRole(user.role, "candidate");
        const input = await body(request);
        const key = idempotencyKey(request);
        const result = await apply(request, user, key, applyReference, input);
        json(response, 201, result);
        return;
      }

      const withdrawal = withdrawalReference(url.pathname);
      if (request.method === "DELETE" && withdrawal !== null) {
        requireRole(user.role, "candidate");
        const erased = await serialize(async () =>
          store.eraseCandidateApplication(user.tenantId, withdrawal, user.actor, Date.now())
        );
        if (!erased) throw new HttpError(404, "not-found");
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return;
      }

      requireStaff(user.role);

      const target = applicationAction(url.pathname);
      if (request.method === "POST" && target !== null) {
        requireRole(user.role, "recruiter");
        const input = await body(request);
        if (target.action === "hire") {
          const key = idempotencyKey(request);
          json(response, 201, await hireApplication(user, key, target.reference, target.applicationId, input));
          return;
        }
        if (target.action === "review") {
          const key = idempotencyKey(request);
          json(response, 200, await reviewApplication(user, key, target.reference, target.applicationId, input));
          return;
        }
        accessible(user, target.reference, false);
        const reason = boundedText(input.reason, "reason", 500);
        const erased = await serialize(async () =>
          store.eraseApplication(user.tenantId, target.reference, target.applicationId, reason, Date.now())
        );
        if (!erased) throw new HttpError(404, "not-found");
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/people") {
        json(response, 200, store.employees(user.tenantId));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/requisitions") {
        json(response, 200, store.list(user.tenantId, user.role === "requester" ? user.actor : undefined));
        return;
      }

      const reference = pathReference(url.pathname);
      if (request.method === "GET" && reference !== null && url.pathname === `/api/requisitions/${reference}`) {
        json(response, 200, accessible(user, reference, user.role === "requester"));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/requisitions") {
        requireRole(user.role, "requester");
        const input = await body(request);
        const key = idempotencyKey(request);
        const result = await mutate(user, key, "create-draft", input, () => ({
          current: null,
          command: {
            kind: "create-draft",
            reference: store.allocateReference(),
            actor: user.actor,
            tick: Date.now(),
            fields: fields(input.fields)
          }
        }));
        json(response, 201, result);
        return;
      }

      if (request.method === "PUT" && reference !== null && url.pathname === `/api/requisitions/${reference}`) {
        requireRole(user.role, "requester");
        const input = await body(request);
        const key = idempotencyKey(request);
        const result = await mutate(user, key, "update-draft", input, () => {
          const current = accessible(user, reference, true);
          return {
            current,
            command: {
              kind: "update-draft",
              reference,
              generation: integer(input.generation, "generation"),
              actor: user.actor,
              tick: Date.now(),
              fields: fields(input.fields)
            }
          };
        });
        json(response, 200, result);
        return;
      }

      if (
        request.method === "POST" &&
        reference !== null &&
        url.pathname === `/api/requisitions/${reference}/submit`
      ) {
        requireRole(user.role, "requester");
        const input = await body(request);
        const key = idempotencyKey(request);
        const result = await mutate(user, key, "submit-draft", input, () => {
          const current = accessible(user, reference, true);
          return {
            current,
            command: {
              kind: "submit-draft",
              reference,
              generation: integer(input.generation, "generation"),
              actor: user.actor,
              tick: Date.now()
            }
          };
        });
        json(response, 200, result);
        return;
      }

      if (
        request.method === "POST" &&
        reference !== null &&
        url.pathname === `/api/requisitions/${reference}/review`
      ) {
        requireRole(user.role, "approver");
        const input = await body(request);
        const key = idempotencyKey(request);
        const decision = text(input.decision, "decision") as ReviewDecision;
        if (!["approve", "decline", "hold"].includes(decision)) {
          throw new HttpError(400, "invalid-decision");
        }
        const result = await mutate(user, key, "review", input, () => {
          const current = accessible(user, reference, false);
          return {
            current,
            command: {
              kind: "review",
              reference,
              generation: integer(input.generation, "generation"),
              actor: user.actor,
              tick: Date.now(),
              decision,
              reason: text(input.reason ?? "", "reason")
            }
          };
        });
        json(response, 200, result);
        return;
      }

      if (
        request.method === "POST" &&
        reference !== null &&
        url.pathname === `/api/requisitions/${reference}/resubmit`
      ) {
        requireRole(user.role, "requester");
        const input = await body(request);
        const key = idempotencyKey(request);
        const result = await mutate(user, key, "resubmit", input, () => {
          const current = accessible(user, reference, true);
          return {
            current,
            command: {
              kind: "resubmit",
              reference,
              generation: integer(input.generation, "generation"),
              actor: user.actor,
              tick: Date.now(),
              fields: fields(input.fields)
            }
          };
        });
        json(response, 200, result);
        return;
      }

      if (
        request.method === "POST" &&
        reference !== null &&
        url.pathname === `/api/requisitions/${reference}/advert`
      ) {
        requireRole(user.role, "recruiter");
        const input = await body(request);
        const key = idempotencyKey(request);
        const schema = advertSchema(input);
        const result = await mutate(user, key, "publish", input, () => {
          const current = accessible(user, reference, false);
          return {
            current,
            command: {
              kind: "publish",
              reference,
              generation: integer(input.generation, "generation"),
              actor: user.actor,
              tick: Date.now(),
              ...schema
            }
          };
        });
        json(response, 200, result);
        return;
      }

      if (
        request.method === "GET" &&
        reference !== null &&
        url.pathname === `/api/requisitions/${reference}/applications`
      ) {
        requireRole(user.role, "recruiter");
        accessible(user, reference, false);
        json(response, 200, store.applications(user.tenantId, reference));
        return;
      }

      throw new HttpError(404, "not-found");
    } catch (error) {
      const failure = mapError(error);
      if (failure.status === 500) console.error(error);
      if (failure.status === 429) response.setHeader("retry-after", String(Math.ceil(limits.windowMs / 1000)));
      json(response, failure.status, { error: failure.code } satisfies ApiError);
    }
  });

  return {
    server,
    store,
    maintain,
    async close(): Promise<void> {
      if (timer !== null) clearInterval(timer);
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error === undefined ? resolveClose() : reject(error)));
      });
      store.close();
    }
  };
}
