import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import type {
  ApiError,
  DemoRole,
  RequisitionCase,
  RequisitionFields,
  ReviewDecision,
  WorkflowCommand
} from "../../../packages/contracts/src/index.js";
import { RecruitmentStore, StoreError } from "./store.js";
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
}

export interface ApplicationOptions {
  databasePath: string;
  workflowExecutable?: string;
  webRoot?: string;
}

export interface Application {
  server: Server;
  store: RecruitmentStore;
  close(): Promise<void>;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

function identity(request: IncomingMessage): Identity {
  const actor = request.headers["x-demo-actor"];
  const role = request.headers["x-demo-role"];
  if (typeof actor !== "string" || actor.trim() === "") throw new HttpError(401, "identity-required");
  if (role !== "requester" && role !== "approver") throw new HttpError(401, "role-required");
  return { actor: actor.trim(), role };
}

function requireRole(actual: DemoRole, expected: DemoRole): void {
  if (actual !== expected) throw new HttpError(403, `${expected}-role-required`);
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
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

function pathReference(pathname: string): number | null {
  const match = /^\/api\/requisitions\/(\d+)(?:\/.*)?$/u.exec(pathname);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function mapError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const code =
    error instanceof WorkflowError || error instanceof StoreError ? error.code : "internal-server-error";
  if (code === "not-found") return new HttpError(404, code);
  if (code === "stale-version" || code === "wrong-stage" || code === "audit-history-mismatch") {
    return new HttpError(409, code);
  }
  if (
    code.startsWith("invalid-") ||
    code === "reason-required" ||
    code === "identity-required" ||
    code === "role-required"
  ) {
    return new HttpError(400, code);
  }
  return new HttpError(500, code);
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
  const replayed = await workflow.evaluate(store.commands());
  store.validateProjection(replayed);

  let mutationTail: Promise<void> = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async function mutate(command: WorkflowCommand): Promise<RequisitionCase> {
    return serialize(async () => {
      const result = await workflow.evaluate([...store.commands(), command]);
      if (result.latestReference === null) throw new WorkflowError("missing-latest-case");
      const latest = result.cases.find((candidate) => candidate.reference === result.latestReference);
      if (latest === undefined) throw new WorkflowError("missing-latest-case");
      store.commit(command, latest);
      return latest;
    });
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/api/")) {
        if (options.webRoot !== undefined && serveWeb(url.pathname, options.webRoot, response)) return;
        throw new HttpError(404, "not-found");
      }

      const user = identity(request);
      if (request.method === "GET" && url.pathname === "/api/health") {
        json(response, 200, { status: "ok", workflow: "idris", requisitions: store.list().length });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/requisitions") {
        json(response, 200, store.list());
        return;
      }

      const reference = pathReference(url.pathname);
      if (request.method === "GET" && reference !== null && url.pathname === `/api/requisitions/${reference}`) {
        const result = store.get(reference);
        if (result === null) throw new HttpError(404, "not-found");
        json(response, 200, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/requisitions") {
        requireRole(user.role, "requester");
        const input = await body(request);
        const result = await mutate({
          kind: "create-draft",
          actor: user.actor,
          tick: Date.now(),
          fields: fields(input.fields)
        });
        json(response, 201, result);
        return;
      }

      if (request.method === "PUT" && reference !== null && url.pathname === `/api/requisitions/${reference}`) {
        requireRole(user.role, "requester");
        const input = await body(request);
        const result = await mutate({
          kind: "update-draft",
          reference,
          generation: integer(input.generation, "generation"),
          actor: user.actor,
          tick: Date.now(),
          fields: fields(input.fields)
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
        const result = await mutate({
          kind: "submit-draft",
          reference,
          generation: integer(input.generation, "generation"),
          actor: user.actor,
          tick: Date.now()
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
        const decision = text(input.decision, "decision") as ReviewDecision;
        if (!["approve", "decline", "hold"].includes(decision)) {
          throw new HttpError(400, "invalid-decision");
        }
        const result = await mutate({
          kind: "review",
          reference,
          generation: integer(input.generation, "generation"),
          actor: user.actor,
          tick: Date.now(),
          decision,
          reason: text(input.reason ?? "", "reason")
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
        const result = await mutate({
          kind: "resubmit",
          reference,
          generation: integer(input.generation, "generation"),
          actor: user.actor,
          tick: Date.now(),
          fields: fields(input.fields)
        });
        json(response, 200, result);
        return;
      }

      throw new HttpError(404, "not-found");
    } catch (error) {
      const failure = mapError(error);
      if (failure.status === 500) console.error(error);
      json(response, failure.status, { error: failure.code } satisfies ApiError);
    }
  });

  return {
    server,
    store,
    async close(): Promise<void> {
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error === undefined ? resolveClose() : reject(error)));
      });
      store.close();
    }
  };
}
