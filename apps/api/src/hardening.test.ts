import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  application,
  approvedRequisition,
  publish,
  request,
  withApplication,
  type RunningApplication
} from "./test-support.js";

async function hiredAndWithdrawn(running: RunningApplication, candidate: string): Promise<number> {
  const { reference } = await publish(running, await approvedRequisition(running));
  const applied = await request(running, `/api/adverts/${reference}/applications`, {
    role: "candidate",
    actor: candidate,
    method: "POST",
    body: application({ candidateName: "Private Person" })
  });
  assert.equal(applied.status, 201);
  const base = `/api/requisitions/${reference}/applications/1`;
  assert.equal(
    (await request(running, `${base}/review`, { role: "recruiter", method: "POST", body: { disposition: "shortlist", note: "Met Private" } })).status,
    200
  );
  assert.equal(
    (await request(running, `${base}/hire`, { role: "recruiter", method: "POST", body: { legalName: "Private Person", startDate: "2026-11-02" } })).status,
    201
  );
  const withdrawn = await request(running, `/api/adverts/${reference}/applications/mine`, {
    role: "candidate",
    actor: candidate,
    method: "DELETE"
  });
  assert.equal(withdrawn.status, 204);
  return reference;
}

test("erasure leaves no candidate identity in any application or people response", async () => {
  await withApplication("erasure-identity", async (running) => {
    const candidate = "private@example.test";
    const reference = await hiredAndWithdrawn(running, candidate);
    const applications = await request(running, `/api/requisitions/${reference}/applications`, { role: "recruiter" });
    const people = await request(running, "/api/people", { role: "recruiter" });
    for (const body of [applications.json, people.json]) {
      const serialised = JSON.stringify(body);
      assert.ok(!serialised.includes(candidate), `candidate email leaked: ${serialised}`);
      assert.ok(!serialised.includes("Met Private"), "review note survived erasure");
    }
    const [record] = applications.json as Array<{ candidateActor: string; evidence: { actor: string } }>;
    assert.equal(record?.evidence.actor, record?.candidateActor);
    assert.match(record?.evidence.actor ?? "", /^erased:/u);
  });
});

test("an idempotent retry is replayed even when the rate limit is exhausted", async () => {
  await withApplication(
    "retry-limit",
    async (running) => {
      const { reference } = await publish(running, await approvedRequisition(running));
      const key = randomUUID();
      const send = (idempotencyKey: string) =>
        request(running, `/api/adverts/${reference}/applications`, {
          role: "candidate",
          actor: "retry@example.test",
          method: "POST",
          idempotencyKey,
          body: application()
        });
      const first = await send(key);
      assert.equal(first.status, 201);
      const retry = await send(key);
      assert.equal(retry.status, 201);
      assert.deepEqual(retry.json, first.json);
      assert.equal((await send(randomUUID())).status, 429);
    },
    { applyRateLimit: { perCandidate: 1, perAddress: 100, windowMs: 60_000 } }
  );
});

test("impossible calendar dates are refused rather than rolled over", async () => {
  await withApplication("dates", async (running) => {
    const { reference } = await publish(running, await approvedRequisition(running));
    await request(running, `/api/adverts/${reference}/applications`, {
      role: "candidate",
      actor: "date@example.test",
      method: "POST",
      body: application()
    });
    const base = `/api/requisitions/${reference}/applications/1`;
    await request(running, `${base}/review`, { role: "recruiter", method: "POST", body: { disposition: "shortlist" } });
    for (const startDate of ["2026-02-31", "2026-13-01", "2026-00-10", "2026-2-1"]) {
      const refused = await request(running, `${base}/hire`, {
        role: "recruiter",
        method: "POST",
        body: { legalName: "Date Person", startDate }
      });
      assert.deepEqual(refused.json, { error: "invalid-start-date" }, startDate);
    }
    const leap = await request(running, `${base}/hire`, {
      role: "recruiter",
      method: "POST",
      body: { legalName: "Date Person", startDate: "2028-02-29" }
    });
    assert.equal((leap.json as { startDate: string }).startDate, "2028-02-29");
  });
});

test("every provenance column is protected by its trigger", async () => {
  await withApplication("columns", async (running, databasePath) => {
    await hiredAndWithdrawn(running, "columns@example.test");
    const database = new DatabaseSync(databasePath);
    try {
      for (const column of [
        "employee_id",
        "tenant_id",
        "reference",
        "application_id",
        "legal_name",
        "start_tick",
        "hired_by",
        "hired_tick",
        "evidence_revision",
        "evidence_detail",
        "created_at"
      ]) {
        const value = column === "legal_name" || column.endsWith("_by") || column.endsWith("detail") || column === "tenant_id" ? "'x'" : "999";
        assert.throws(
          () => database.prepare(`UPDATE employees SET ${column} = ${value}`).run(),
          /provenance-immutable/u,
          `employees.${column}`
        );
      }
      // The application is erased, so only reason and note may still be cleared.
      for (const [column, value] of [
        ["reference", "999"],
        ["application_id", "999"],
        ["disposition", "'reject'"],
        ["reviewer", "'x'"],
        ["tick", "999"],
        ["revision", "999"],
        ["detail", "'x'"],
        ["created_at", "999"]
      ] as const) {
        assert.throws(
          () => database.prepare(`UPDATE application_reviews SET ${column} = ${value}`).run(),
          /review-immutable/u,
          `application_reviews.${column}`
        );
      }
      assert.doesNotThrow(() => database.prepare("UPDATE application_reviews SET reason = '', note = ''").run());
    } finally {
      database.close();
    }
  });
});
