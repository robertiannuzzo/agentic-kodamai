import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  AdvertQuestion,
  AssessRequest,
  Disposition,
  HireRequest,
  AdvertSkill,
  AuditEntry,
  IntakeRequest,
  RequisitionFields,
  RequisitionStage,
  ScoreReceipt,
  WorkflowCase,
  WorkflowCommand,
  WorkflowResult
} from "../../../packages/contracts/src/index.js";

const execFileAsync = promisify(execFile);

export class WorkflowError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WorkflowError";
  }
}

function characterLength(value: string): number {
  return Array.from(value).length;
}

export function encodeFrames(values: readonly string[]): string {
  return values.map((value) => `${characterLength(value)}:${value},`).join("");
}

export function decodeFrames(input: string): string[] {
  const chars = Array.from(input.endsWith("\n") ? input.slice(0, -1) : input);
  const values: string[] = [];
  let index = 0;

  while (index < chars.length) {
    const start = index;
    while (index < chars.length && /[0-9]/u.test(chars[index] ?? "")) index += 1;
    if (start === index || chars[index] !== ":") throw new WorkflowError("invalid-worker-response");
    const sizeText = chars.slice(start, index).join("");
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0 || String(size) !== sizeText) {
      throw new WorkflowError("invalid-worker-response");
    }
    index += 1;
    const value = chars.slice(index, index + size);
    if (value.length !== size || chars[index + size] !== ",") {
      throw new WorkflowError("invalid-worker-response");
    }
    values.push(value.join(""));
    index += size + 1;
  }

  return values;
}

const protocol = "recruitment-kernel-v5";
const resultProtocol = "recruitment-kernel-result-v5";

function fieldValues(fields: RequisitionFields): string[] {
  return [
    fields.role,
    fields.department,
    String(fields.headcount),
    String(fields.budgetMinor),
    fields.justification
  ];
}

function auditValues(entry: AuditEntry): string[] {
  return [
    entry.event,
    entry.actor,
    String(entry.tick),
    String(entry.reference),
    String(entry.revision),
    entry.detail
  ];
}

function schemaValues(questions: readonly AdvertQuestion[], skills: readonly AdvertSkill[]): string[] {
  return [
    String(questions.length),
    ...questions.flatMap((q) => [String(q.questionId), q.prompt, q.expected]),
    String(skills.length),
    ...skills.flatMap((s) => [String(s.skillId), s.keyword, String(s.weight), String(s.targetYears)])
  ];
}

function caseValues(row: WorkflowCase): string[] {
  return [
    String(row.reference),
    String(row.generation),
    row.stage,
    String(row.revision),
    ...fieldValues(row),
    String(row.history.length),
    ...row.history.flatMap(auditValues),
    ...schemaValues(row.advert?.questions ?? [], row.advert?.skills ?? [])
  ];
}

function commandValues(command: WorkflowCommand): string[] {
  switch (command.kind) {
    case "create-draft":
      return [String(command.reference), command.actor, String(command.tick), ...fieldValues(command.fields)];
    case "update-draft":
    case "resubmit":
      return [
        String(command.reference),
        String(command.generation),
        command.actor,
        String(command.tick),
        ...fieldValues(command.fields)
      ];
    case "submit-draft":
      return [
        String(command.reference),
        String(command.generation),
        command.actor,
        String(command.tick)
      ];
    case "review":
      return [
        String(command.reference),
        String(command.generation),
        command.actor,
        String(command.tick),
        command.decision,
        command.reason
      ];
    case "publish":
      return [
        String(command.reference),
        String(command.generation),
        command.actor,
        String(command.tick),
        ...schemaValues(command.questions, command.skills)
      ];
  }
}

export function encodeTransition(current: WorkflowCase | null, command: WorkflowCommand): string {
  const args = commandValues(command);
  return encodeFrames([
    protocol,
    "transition",
    current === null ? "none" : "some",
    ...(current === null ? [] : caseValues(current)),
    command.kind,
    String(args.length),
    ...args
  ]);
}

function applicationValues(request: IntakeRequest): string[] {
  return [
    String(request.applicationId),
    request.actor,
    String(request.tick),
    request.cv.locator,
    request.cv.version,
    request.cv.text,
    String(request.answers.length),
    ...request.answers.flatMap(({ questionId, answer }) => [String(questionId), answer]),
    String(request.years.length),
    ...request.years.flatMap(({ skillId, years }) => [String(skillId), String(years)])
  ];
}

export function encodeIntake(advertised: WorkflowCase, request: IntakeRequest): string {
  return encodeFrames([protocol, "intake", ...caseValues(advertised), ...applicationValues(request)]);
}

function storedValues(request: AssessRequest): string[] {
  const { breakdown, evidence } = request.stored;
  return [
    ...applicationValues(request.application),
    String(breakdown.keywords),
    String(breakdown.experience),
    String(breakdown.screening),
    String(breakdown.completeness),
    evidence.actor,
    String(evidence.tick),
    String(evidence.reference),
    String(evidence.revision),
    evidence.detail
  ];
}

export function encodeAssess(advertised: WorkflowCase, request: AssessRequest): string {
  return encodeFrames([
    protocol,
    "assess",
    ...caseValues(advertised),
    ...storedValues(request),
    request.reviewer,
    String(request.tick),
    request.disposition,
    request.reason
  ]);
}

export function encodeHire(advertised: WorkflowCase, request: HireRequest): string {
  return encodeFrames([
    protocol,
    "hire",
    ...caseValues(advertised),
    ...storedValues(request.assessment),
    request.review.actor,
    String(request.review.tick),
    request.assessment.disposition,
    String(request.review.revision),
    request.review.detail,
    request.hirer,
    String(request.tick),
    request.legalName,
    String(request.startTick)
  ]);
}

export interface HireResult {
  legalName: string;
  startTick: number;
  reference: number;
  applicationId: number;
  evidence: AuditEntry;
}

function readHire(reader: FieldReader): HireResult {
  const legalName = reader.read();
  const startTick = reader.number();
  const reference = reader.number();
  const applicationId = reader.number();
  return {
    legalName,
    startTick,
    reference,
    applicationId,
    evidence: {
      event: "hired",
      actor: reader.read(),
      tick: reader.number(),
      reference: reader.number(),
      revision: reader.number(),
      detail: reader.read()
    }
  };
}

function safeNumber(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || String(result) !== value) {
    throw new WorkflowError("invalid-worker-response");
  }
  return result;
}

class FieldReader {
  private index = 0;

  constructor(private readonly fields: readonly string[]) {}

  read(): string {
    const value = this.fields[this.index];
    if (value === undefined) throw new WorkflowError("invalid-worker-response");
    this.index += 1;
    return value;
  }

  number(): number {
    return safeNumber(this.read());
  }

  get complete(): boolean {
    return this.index === this.fields.length;
  }
}

function readAudit(reader: FieldReader): AuditEntry {
  return {
    event: reader.read(),
    actor: reader.read(),
    tick: reader.number(),
    reference: reader.number(),
    revision: reader.number(),
    detail: reader.read()
  };
}

const stages: readonly RequisitionStage[] = [
  "draft",
  "awaiting-review",
  "approved",
  "needs-rework",
  "declined",
  "advertising"
];

function readCase(reader: FieldReader): WorkflowCase {
  const reference = reader.number();
  const generation = reader.number();
  const stage = reader.read() as RequisitionStage;
  if (!stages.includes(stage)) throw new WorkflowError("invalid-worker-response");
  const revision = reader.number();
  const role = reader.read();
  const department = reader.read();
  const headcount = reader.number();
  const budgetMinor = reader.number();
  const justification = reader.read();
  const auditCount = reader.number();
  const history = Array.from({ length: auditCount }, () => readAudit(reader));
  const questions = Array.from({ length: reader.number() }, () => ({
    questionId: reader.number(),
    prompt: reader.read(),
    expected: reader.read()
  }));
  const skills = Array.from({ length: reader.number() }, () => ({
    skillId: reader.number(),
    keyword: reader.read(),
    weight: reader.number(),
    targetYears: reader.number()
  }));
  const advert = stage === "advertising" ? { questions, skills } : null;
  if (advert === null && (questions.length > 0 || skills.length > 0)) {
    throw new WorkflowError("invalid-worker-response");
  }
  return {
    reference,
    generation,
    stage,
    revision,
    role,
    department,
    headcount,
    budgetMinor,
    justification,
    history,
    advert
  };
}

function readReceipt(reader: FieldReader): ScoreReceipt {
  return {
    applicationId: reader.number(),
    breakdown: {
      keywords: reader.number(),
      experience: reader.number(),
      screening: reader.number(),
      completeness: reader.number()
    },
    total: reader.number(),
    policyVersion: reader.read(),
    evidence: {
      event: "application-scored",
      actor: reader.read(),
      tick: reader.number(),
      reference: reader.number(),
      revision: reader.number(),
      detail: reader.read()
    }
  };
}

function readReview(reader: FieldReader): { disposition: Disposition; evidence: AuditEntry } {
  const disposition = reader.read();
  if (disposition !== "shortlist" && disposition !== "reject") {
    throw new WorkflowError("invalid-worker-response");
  }
  return {
    disposition,
    evidence: {
      event: "application-reviewed",
      actor: reader.read(),
      tick: reader.number(),
      reference: reader.number(),
      revision: reader.number(),
      detail: reader.read()
    }
  };
}

function decodeResult<T>(output: string, kind: string, read: (reader: FieldReader) => T): T {
  const reader = new FieldReader(decodeFrames(output));
  if (reader.read() !== resultProtocol) throw new WorkflowError("invalid-worker-response");
  const status = reader.read();
  if (status === "error") throw new WorkflowError(reader.read());
  if (status !== kind) throw new WorkflowError("invalid-worker-response");
  const result = read(reader);
  if (!reader.complete) throw new WorkflowError("invalid-worker-response");
  return result;
}

export class WorkflowClient {
  readonly executable: string;

  constructor(executable = resolve(process.cwd(), "build/exec/recruitment-workflow")) {
    this.executable = executable;
  }

  async evaluate(current: WorkflowCase | null, command: WorkflowCommand): Promise<WorkflowResult> {
    const output = await this.call(encodeTransition(current, command));
    return { result: decodeResult(output, "case", readCase) };
  }

  async intake(advertised: WorkflowCase, request: IntakeRequest): Promise<ScoreReceipt> {
    const output = await this.call(encodeIntake(advertised, request));
    return decodeResult(output, "receipt", readReceipt);
  }

  async assess(
    advertised: WorkflowCase,
    request: AssessRequest
  ): Promise<{ disposition: Disposition; evidence: AuditEntry }> {
    const output = await this.call(encodeAssess(advertised, request));
    return decodeResult(output, "review", readReview);
  }

  async hire(advertised: WorkflowCase, request: HireRequest): Promise<HireResult> {
    const output = await this.call(encodeHire(advertised, request));
    return decodeResult(output, "hired", readHire);
  }

  private async call(input: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "recruitment-workflow-"));
    const inputPath = join(directory, "request.frames");
    try {
      await writeFile(inputPath, input, { encoding: "utf8", mode: 0o600 });
      const { stdout } = await execFileAsync(this.executable, [inputPath], {
        cwd: process.cwd(),
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: 10_000
      });
      return stdout;
    } catch (error) {
      const message = error instanceof Error ? error.message : "workflow-process-failed";
      throw new WorkflowError(`workflow-process-failed:${message}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
