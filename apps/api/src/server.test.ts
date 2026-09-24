import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  options: { method?: string; role?: DemoRole; body?: unknown } = {}
): Promise<{ status: number; json: unknown }> {
  const role = options.role ?? "requester";
  const response = await fetch(`${running.origin}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-demo-role": role,
      "x-demo-actor": `${role}@example.test`
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  });
  return { status: response.status, json: (await response.json()) as unknown };
}

test("requisition and approval slice persists and replays through Idris", async () => {
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
