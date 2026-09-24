import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { DemoRole, RequisitionCase } from "../../../packages/contracts/src/index.js";
import { createApplication, type Application } from "./server.js";

interface RunningApplication {
  application: Application;
  origin: string;
}

async function start(databasePath: string): Promise<RunningApplication> {
  const application = await createApplication({ databasePath });
  await new Promise<void>((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const address = application.server.address() as AddressInfo;
  return { application, origin: `http://127.0.0.1:${address.port}` };
}

async function request(
  running: RunningApplication,
  path: string,
  options: {
    method?: string;
    role?: DemoRole;
    actor?: string;
    tenantId?: string;
    idempotencyKey?: string;
    body?: unknown;
  } = {}
): Promise<{ status: number; json: unknown }> {
  const role = options.role ?? "requester";
  const method = options.method ?? "GET";
  const response = await fetch(`${running.origin}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-demo-role": role,
      "x-demo-actor": options.actor ?? `${role}@example.test`,
      "x-demo-tenant": options.tenantId ?? "demo",
      ...(method === "GET"
        ? {}
        : { "idempotency-key": options.idempotencyKey ?? randomUUID() })
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  });
  return { status: response.status, json: (await response.json()) as unknown };
}

test("requisition and approval slice persists and transitions through Idris", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentic-kodamai-"));
  const databasePath = join(directory, "slice.sqlite");
  let running = await start(databasePath);

  try {
    const created = await request(running, "/api/requisitions", {
      method: "POST",
      body: {
        fields: {
          role: "Senior 🎼 Engineer",
          department: "Product",
          headcount: 1,
          budgetMinor: 18000000,
          justification: "Build reliable systems.\nWork across teams."
        }
      }
    });
    assert.equal(created.status, 201);
    let row = created.json as RequisitionCase;
    assert.equal(row.reference, 1);
    assert.equal(row.tenantId, "demo");
    assert.equal(row.requesterId, "requester@example.test");
    assert.equal(row.generation, 0);
    assert.equal(row.stage, "draft");
    assert.deepEqual(row.history.map(({ event }) => event), ["draft-created"]);

    const edited = await request(running, "/api/requisitions/1", {
      method: "PUT",
      body: {
        generation: row.generation,
        fields: {
          role: row.role,
          department: row.department,
          headcount: 2,
          budgetMinor: row.budgetMinor,
          justification: row.justification
        }
      }
    });
    assert.equal(edited.status, 200);
    row = edited.json as RequisitionCase;
    assert.equal(row.generation, 1);
    assert.equal(row.headcount, 2);

    const submitted = await request(running, "/api/requisitions/1/submit", {
      method: "POST",
      body: { generation: row.generation }
    });
    assert.equal(submitted.status, 200);
    row = submitted.json as RequisitionCase;
    assert.equal(row.stage, "awaiting-review");
    assert.equal(row.generation, 2);

    const forbidden = await request(running, "/api/requisitions/1/review", {
      method: "POST",
      body: { generation: row.generation, decision: "approve", reason: "" }
    });
    assert.equal(forbidden.status, 403);

    const held = await request(running, "/api/requisitions/1/review", {
      method: "POST",
      role: "approver",
      body: { generation: row.generation, decision: "hold", reason: "Clarify team ownership" }
    });
    assert.equal(held.status, 200);
    row = held.json as RequisitionCase;
    assert.equal(row.stage, "needs-rework");
    assert.equal(row.generation, 3);

    const resubmitted = await request(running, "/api/requisitions/1/resubmit", {
      method: "POST",
      body: {
        generation: row.generation,
        fields: { ...row, justification: "Own the typed workflow platform and partner with Product." }
      }
    });
    assert.equal(resubmitted.status, 200);
    row = resubmitted.json as RequisitionCase;
    assert.equal(row.stage, "awaiting-review");
    assert.equal(row.revision, 1);
    assert.deepEqual(row.history.slice(-2).map(({ event }) => event), ["revised", "submitted"]);

    const approved = await request(running, "/api/requisitions/1/review", {
      method: "POST",
      role: "approver",
      body: { generation: row.generation, decision: "approve", reason: "" }
    });
    assert.equal(approved.status, 200);
    row = approved.json as RequisitionCase;
    assert.equal(row.stage, "approved");
    assert.equal(row.generation, 5);

    const stale = await request(running, "/api/requisitions/1/review", {
      method: "POST",
      role: "approver",
      body: { generation: 4, decision: "decline", reason: "Too late" }
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(stale.json, { error: "stale-version" });

    await running.application.close();
    running = await start(databasePath);
    const afterRestart = await request(running, "/api/requisitions/1");
    assert.equal(afterRestart.status, 200);
    const reconstructed = afterRestart.json as RequisitionCase;
    assert.equal(reconstructed.stage, "approved");
    assert.equal(reconstructed.revision, 1);
    assert.equal(reconstructed.history.length, 7);
    assert.equal(reconstructed.role, "Senior 🎼 Engineer");
  } finally {
    await running.application.close().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Idris validation errors are returned as API errors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentic-kodamai-invalid-"));
  const running = await start(join(directory, "slice.sqlite"));
  try {
    const response = await request(running, "/api/requisitions", {
      method: "POST",
      body: {
        fields: {
          role: "",
          department: "Product",
          headcount: 1,
          budgetMinor: 100,
          justification: "Required"
        }
      }
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.json, { error: "invalid-field:role" });
  } finally {
    await running.application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("health is public and mutations require an idempotency key", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentic-kodamai-boundary-"));
  const running = await start(join(directory, "slice.sqlite"));
  try {
    const health = await fetch(`${running.origin}/api/health`);
    assert.equal(health.status, 200);
    assert.match(health.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/u);

    const missingKey = await fetch(`${running.origin}/api/requisitions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-demo-role": "requester",
        "x-demo-actor": "requester@example.test",
        "x-demo-tenant": "demo"
      },
      body: JSON.stringify({
        fields: {
          role: "Engineer",
          department: "Engineering",
          headcount: 1,
          budgetMinor: 100,
          justification: "Exercise the HTTP contract."
        }
      })
    });
    assert.equal(missingKey.status, 400);
    assert.deepEqual(await missingKey.json(), { error: "idempotency-key-required" });
  } finally {
    await running.application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("decline is covered by the cross-language transition contract", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentic-kodamai-decline-"));
  const running = await start(join(directory, "slice.sqlite"));
  try {
    const created = await request(running, "/api/requisitions", {
      method: "POST",
      body: {
        fields: {
          role: "Support Engineer",
          department: "Customer Experience",
          headcount: 1,
          budgetMinor: 12000000,
          justification: "Cover the terminal review branch."
        }
      }
    });
    const draft = created.json as RequisitionCase;
    const submitted = await request(running, `/api/requisitions/${draft.reference}/submit`, {
      method: "POST",
      body: { generation: draft.generation }
    });
    const pending = submitted.json as RequisitionCase;
    const declined = await request(running, `/api/requisitions/${draft.reference}/review`, {
      method: "POST",
      role: "approver",
      body: { generation: pending.generation, decision: "decline", reason: "Budget withdrawn" }
    });
    assert.equal(declined.status, 200);
    const row = declined.json as RequisitionCase;
    assert.equal(row.stage, "declined");
    assert.equal(row.history.at(-1)?.detail, "Budget withdrawn");
  } finally {
    await running.application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("mutation retries are idempotent and key reuse with another payload conflicts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentic-kodamai-idempotency-"));
  const running = await start(join(directory, "slice.sqlite"));
  const key = randomUUID();
  const original = {
    fields: {
      role: "Platform Engineer",
      department: "Engineering",
      headcount: 1,
      budgetMinor: 17000000,
      justification: "Own the workflow boundary."
    }
  };
  try {
    const first = await request(running, "/api/requisitions", {
      method: "POST",
      idempotencyKey: key,
      body: original
    });
    const retry = await request(running, "/api/requisitions", {
      method: "POST",
      idempotencyKey: key,
      body: original
    });
    assert.equal(first.status, 201);
    assert.equal(retry.status, 201);
    assert.deepEqual(retry.json, first.json);

    const conflict = await request(running, "/api/requisitions", {
      method: "POST",
      idempotencyKey: key,
      body: { ...original, fields: { ...original.fields, headcount: 2 } }
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.json, { error: "idempotency-key-conflict" });

    const listed = await request(running, "/api/requisitions");
    assert.equal(listed.status, 200);
    assert.equal((listed.json as RequisitionCase[]).length, 1);
  } finally {
    await running.application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tenant and requester ownership scope reads and writes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentic-kodamai-authorization-"));
  const running = await start(join(directory, "slice.sqlite"));
  try {
    const created = await request(running, "/api/requisitions", {
      method: "POST",
      actor: "alice@example.test",
      tenantId: "tenant-a",
      body: {
        fields: {
          role: "Security Engineer",
          department: "Engineering",
          headcount: 1,
          budgetMinor: 19000000,
          justification: "Build tenant isolation."
        }
      }
    });
    assert.equal(created.status, 201);

    const otherRequester = await request(running, "/api/requisitions/1", {
      actor: "bob@example.test",
      tenantId: "tenant-a"
    });
    assert.equal(otherRequester.status, 404);

    const forbiddenWrite = await request(running, "/api/requisitions/1", {
      method: "PUT",
      actor: "bob@example.test",
      tenantId: "tenant-a",
      body: {
        generation: 0,
        fields: {
          role: "Changed by Bob",
          department: "Engineering",
          headcount: 1,
          budgetMinor: 19000000,
          justification: "This must not be accepted."
        }
      }
    });
    assert.equal(forbiddenWrite.status, 404);

    const otherTenantApprover = await request(running, "/api/requisitions/1", {
      role: "approver",
      actor: "approver@tenant-b.test",
      tenantId: "tenant-b"
    });
    assert.equal(otherTenantApprover.status, 404);

    const tenantApprover = await request(running, "/api/requisitions/1", {
      role: "approver",
      actor: "approver@tenant-a.test",
      tenantId: "tenant-a"
    });
    assert.equal(tenantApprover.status, 200);

    const hiddenList = await request(running, "/api/requisitions", {
      actor: "bob@example.test",
      tenantId: "tenant-a"
    });
    assert.deepEqual(hiddenList.json, []);
  } finally {
    await running.application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("two application processes converge on one idempotent create", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentic-kodamai-concurrency-"));
  const databasePath = join(directory, "slice.sqlite");
  const [first, second] = await Promise.all([start(databasePath), start(databasePath)]);
  const key = randomUUID();
  const input = {
    fields: {
      role: "Distributed Systems Engineer",
      department: "Engineering",
      headcount: 1,
      budgetMinor: 20000000,
      justification: "Make retries safe across processes."
    }
  };
  try {
    const [left, right] = await Promise.all([
      request(first, "/api/requisitions", { method: "POST", idempotencyKey: key, body: input }),
      request(second, "/api/requisitions", { method: "POST", idempotencyKey: key, body: input })
    ]);
    assert.equal(left.status, 201);
    assert.equal(right.status, 201);
    assert.deepEqual(left.json, right.json);
    const listed = await request(first, "/api/requisitions");
    assert.equal((listed.json as RequisitionCase[]).length, 1);
  } finally {
    await first.application.close();
    await second.application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an existing Slice 1 database is migrated in place", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentic-kodamai-migration-"));
  const databasePath = join(directory, "slice.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE requisitions (
      reference INTEGER PRIMARY KEY,
      generation INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      stage TEXT NOT NULL,
      role TEXT NOT NULL,
      department TEXT NOT NULL,
      headcount INTEGER NOT NULL,
      budget_minor INTEGER NOT NULL,
      justification TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE audit_entries (
      reference INTEGER NOT NULL REFERENCES requisitions(reference),
      ordinal INTEGER NOT NULL,
      event TEXT NOT NULL,
      actor TEXT NOT NULL,
      tick INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      detail TEXT NOT NULL,
      PRIMARY KEY (reference, ordinal)
    );
    INSERT INTO requisitions VALUES
      (7, 0, 0, 'draft', 'Legacy Engineer', 'Engineering', 1, 15000000, 'Retain this row.', 1);
    INSERT INTO audit_entries VALUES
      (7, 0, 'draft-created', 'old@example.test', 1, 0, 'Retain this row.');
  `);
  legacy.close();

  const running = await start(databasePath);
  try {
    const migrated = await request(running, "/api/requisitions/7", {
      actor: "old@example.test",
      tenantId: "demo"
    });
    assert.equal(migrated.status, 200);
    const row = migrated.json as RequisitionCase;
    assert.equal(row.role, "Legacy Engineer");
    assert.equal(row.tenantId, "demo");
    assert.equal(row.requesterId, "old@example.test");

    const created = await request(running, "/api/requisitions", {
      method: "POST",
      actor: "old@example.test",
      tenantId: "demo",
      body: {
        fields: {
          role: "Post-migration Engineer",
          department: "Engineering",
          headcount: 1,
          budgetMinor: 16000000,
          justification: "Prove reference allocation advances."
        }
      }
    });
    assert.equal((created.json as RequisitionCase).reference, 8);
  } finally {
    await running.application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function submittedRequisition(running: RunningApplication, actor: string): Promise<RequisitionCase> {
  const created = await request(running, "/api/requisitions", {
    method: "POST",
    actor,
    body: {
      fields: {
        role: "Platform Engineer",
        department: "Engineering",
        headcount: 1,
        budgetMinor: 9000000,
        justification: "Separation of duties."
      }
    }
  });
  assert.equal(created.status, 201);
  const draft = created.json as RequisitionCase;
  const submitted = await request(running, `/api/requisitions/${draft.reference}/submit`, {
    method: "POST",
    actor,
    body: { generation: draft.generation }
  });
  assert.equal(submitted.status, 200);
  return submitted.json as RequisitionCase;
}

test("a requester cannot approve their own requisition by switching role", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentic-kodamai-duty-"));
  const running = await start(join(directory, "duty.sqlite"));
  try {
    const row = await submittedRequisition(running, "dana@example.test");
    const selfReview = await request(running, `/api/requisitions/${row.reference}/review`, {
      method: "POST",
      role: "approver",
      actor: "dana@example.test",
      body: { generation: row.generation, decision: "approve", reason: "" }
    });
    assert.equal(selfReview.status, 403);
    assert.deepEqual(selfReview.json, { error: "self-review-forbidden" });

    const independent = await request(running, `/api/requisitions/${row.reference}/review`, {
      method: "POST",
      role: "approver",
      actor: "erin@example.test",
      body: { generation: row.generation, decision: "approve", reason: "" }
    });
    assert.equal(independent.status, 200);
    assert.equal((independent.json as RequisitionCase).stage, "approved");
  } finally {
    await running.application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Idris replays stored history and refuses a tampered stage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentic-kodamai-tamper-"));
  const databasePath = join(directory, "tamper.sqlite");
  const running = await start(databasePath);
  try {
    const row = await submittedRequisition(running, "dana@example.test");

    // Bypass the API: claim the requisition was held for rework, with forged
    // evidence from the requester reviewing their own submission.
    const database = new DatabaseSync(databasePath);
    database.exec("BEGIN IMMEDIATE");
    database
      .prepare("UPDATE requisitions SET stage = 'needs-rework', generation = ? WHERE reference = ?")
      .run(row.generation + 1, row.reference);
    database
      .prepare(`INSERT INTO audit_entries (reference, ordinal, event, actor, tick, revision, detail)
        VALUES (?, ?, 'held', 'dana@example.test', ?, 0, 'forged')`)
      .run(row.reference, row.history.length, Date.now());
    database.exec("COMMIT");
    database.close();

    const resubmit = await request(running, `/api/requisitions/${row.reference}/resubmit`, {
      method: "POST",
      actor: "dana@example.test",
      body: {
        generation: row.generation + 1,
        fields: { ...row, justification: "Skipped review." }
      }
    });
    assert.equal(resubmit.status, 500);
    assert.deepEqual(resubmit.json, { error: "internal-server-error" });

    const unchanged = await request(running, `/api/requisitions/${row.reference}`, {
      actor: "dana@example.test"
    });
    assert.equal((unchanged.json as RequisitionCase).history.length, row.history.length + 1);
  } finally {
    await running.application.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
