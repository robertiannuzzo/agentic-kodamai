import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type {
  AuditEntry,
  RequisitionCase,
  RequisitionFields,
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

function fieldArgs(fields: RequisitionFields): string[] {
  return [
    fields.role,
    fields.department,
    String(fields.headcount),
    String(fields.budgetMinor),
    fields.justification
  ];
}

function commandFields(command: WorkflowCommand): string[] {
  switch (command.kind) {
    case "create-draft":
      return [command.actor, String(command.tick), ...fieldArgs(command.fields)];
    case "update-draft":
      return [
        String(command.reference),
        String(command.generation),
        command.actor,
        String(command.tick),
        ...fieldArgs(command.fields)
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
    case "resubmit":
      return [
        String(command.reference),
        String(command.generation),
        command.actor,
        String(command.tick),
        ...fieldArgs(command.fields)
      ];
  }
}

function encodeCommandLog(commands: readonly WorkflowCommand[]): string {
  const values = ["recruitment-workflow-command-log-v1", String(commands.length)];
  for (const command of commands) {
    const args = commandFields(command);
    values.push(command.kind, String(args.length), ...args);
  }
  return encodeFrames(values);
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

function readCase(reader: FieldReader): RequisitionCase {
  const reference = reader.number();
  const generation = reader.number();
  const stage = reader.read() as RequisitionCase["stage"];
  if (!["draft", "awaiting-review", "approved", "needs-rework", "declined", "advertising"].includes(stage)) {
    throw new WorkflowError("invalid-worker-response");
  }
  const revision = reader.number();
  const role = reader.read();
  const department = reader.read();
  const headcount = reader.number();
  const budgetMinor = reader.number();
  const justification = reader.read();
  const auditCount = reader.number();
  const history = Array.from({ length: auditCount }, () => readAudit(reader));
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
    history
  };
}

function decodeResult(output: string): WorkflowResult {
  const reader = new FieldReader(decodeFrames(output));
  if (reader.read() !== "recruitment-workflow-result-v1") {
    throw new WorkflowError("invalid-worker-response");
  }
  const status = reader.read();
  if (status === "error") throw new WorkflowError(reader.read());
  if (status !== "ok") throw new WorkflowError("invalid-worker-response");
  const latest = reader.read();
  const caseCount = reader.number();
  const cases = Array.from({ length: caseCount }, () => readCase(reader));
  if (!reader.complete) throw new WorkflowError("invalid-worker-response");
  return { latestReference: latest === "" ? null : safeNumber(latest), cases };
}

export class WorkflowClient {
  readonly executable: string;

  constructor(executable = resolve(process.cwd(), "build/exec/recruitment-workflow")) {
    this.executable = executable;
  }

  async evaluate(commands: readonly WorkflowCommand[]): Promise<WorkflowResult> {
    try {
      const { stdout } = await execFileAsync(this.executable, [encodeCommandLog(commands)], {
        cwd: process.cwd(),
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: 10_000
      });
      return decodeResult(stdout);
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      const message = error instanceof Error ? error.message : "workflow-process-failed";
      throw new WorkflowError(`workflow-process-failed:${message}`);
    }
  }
}
