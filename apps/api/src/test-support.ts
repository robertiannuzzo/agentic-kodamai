import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { DemoRole, RequisitionCase } from "../../../packages/contracts/src/index.js";
import { pdf } from "../../../tests/fixtures/pdf.js";
import { createApplication, type Application, type ApplicationOptions } from "./server.js";

export { pdf };

export interface RunningApplication {
  application: Application;
  origin: string;
}

export async function start(
  databasePath: string,
  options: Omit<ApplicationOptions, "databasePath"> = {}
): Promise<RunningApplication> {
  const application = await createApplication({ maintenanceIntervalMs: 0, ...options, databasePath });
  await new Promise<void>((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const address = application.server.address() as AddressInfo;
  return { application, origin: `http://127.0.0.1:${address.port}` };
}

export async function request(
  running: RunningApplication,
  path: string,
  options: {
    method?: string;
    role?: DemoRole;
    actor?: string;
    tenantId?: string;
    idempotencyKey?: string;
    body?: unknown;
    /**
     * An application sent as a multipart upload. Its `cvText` becomes the text
     * of a generated PDF in the `cv` part unless `cv` gives the files to send.
     */
    form?: Record<string, unknown>;
    cv?: Buffer[];
  } = {}
): Promise<{ status: number; json: unknown }> {
  const role = options.role ?? "requester";
  const method = options.method ?? "GET";
  let payload: string | FormData | undefined =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  if (options.form !== undefined) {
    const { cvText, ...submission } = options.form;
    const form = new FormData();
    form.append("application", JSON.stringify(submission));
    for (const file of options.cv ?? [pdf(String(cvText ?? "").split("\n"))]) {
      form.append("cv", new Blob([new Uint8Array(file)], { type: "application/pdf" }), "cv.pdf");
    }
    payload = form;
  }
  const response = await fetch(`${running.origin}${path}`, {
    method,
    headers: {
      ...(options.form === undefined ? { "content-type": "application/json" } : {}),
      "x-demo-role": role,
      "x-demo-actor": options.actor ?? `${role}@example.test`,
      "x-demo-tenant": options.tenantId ?? "demo",
      ...(method === "GET"
        ? {}
        : { "idempotency-key": options.idempotencyKey ?? randomUUID() })
    },
    ...(payload === undefined ? {} : { body: payload })
  });
  return { status: response.status, json: response.status === 204 ? null : ((await response.json()) as unknown) };
}

export const schema = {
  questions: [
    { prompt: "Can you work in this time zone?", expected: "yes" },
    { prompt: "Do you use typed programming?", expected: "yes" }
  ],
  skills: [
    { keyword: "idris", weight: 3, targetYears: 5 },
    { keyword: "sql", weight: 2, targetYears: 3 }
  ]
};

export function application(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidateName: "Ada Candidate",
    cvText: "Idris and SQL experience",
    acknowledgedPrivacyNotice: true,
    answers: [
      { questionId: 1, answer: "yes" },
      { questionId: 2, answer: "yes" }
    ],
    years: [
      { skillId: 1, years: 4 },
      { skillId: 2, years: 8 }
    ],
    ...overrides
  };
}

export async function withApplication(
  name: string,
  body: (running: RunningApplication, databasePath: string) => Promise<void>,
  options: Omit<ApplicationOptions, "databasePath"> = {}
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `agentic-kodamai-${name}-`));
  const databasePath = join(directory, "slice2.sqlite");
  const running = await start(databasePath, options);
  try {
    await body(running, databasePath);
  } finally {
    await running.application.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function approvedRequisition(running: RunningApplication): Promise<RequisitionCase> {
  const created = await request(running, "/api/requisitions", {
    method: "POST",
    body: {
      fields: {
        role: "Typed Systems Engineer",
        department: "Engineering",
        headcount: 1,
        budgetMinor: 12000000,
        justification: "Build recruitment tools"
      }
    }
  });
  const draft = created.json as RequisitionCase;
  const submitted = await request(running, `/api/requisitions/${draft.reference}/submit`, {
    method: "POST",
    body: { generation: draft.generation }
  });
  const pending = submitted.json as RequisitionCase;
  const approved = await request(running, `/api/requisitions/${draft.reference}/review`, {
    method: "POST",
    role: "approver",
    body: { generation: pending.generation, decision: "approve", reason: "" }
  });
  assert.equal(approved.status, 200);
  return approved.json as RequisitionCase;
}

export async function publish(running: RunningApplication, row: RequisitionCase): Promise<RequisitionCase> {
  const published = await request(running, `/api/requisitions/${row.reference}/advert`, {
    method: "POST",
    role: "recruiter",
    body: { generation: row.generation, ...schema }
  });
  assert.equal(published.status, 200);
  return published.json as RequisitionCase;
}
