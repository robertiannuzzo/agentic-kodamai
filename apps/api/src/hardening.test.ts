import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  application,
  approvedRequisition,
  publish,
  request,
  start,
  withApplication,
  type RunningApplication
} from "./test-support.js";

async function hiredAndWithdrawn(running: RunningApplication, candidate: string): Promise<number> {
  const { reference } = await publish(running, await approvedRequisition(running));
  const applied = await request(running, `/api/adverts/${reference}/applications`, {
    role: "candidate",
    actor: candidate,
    method: "POST",
    form: application({ candidateName: "Private Person" })
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

test("erasure removes contact identity and notes; the employment record keeps only the legal name", async () => {
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
    // The people record is an employment record retained under the contract of
    // employment (documented exception): it keeps the legal name, nothing else.
    const [person] = people.json as Array<{ legalName: string }>;
    assert.equal(person?.legalName, "Private Person");
    assert.ok(!JSON.stringify(applications.json).includes("Private Person"));
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
          form: application()
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
      form: application()
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

test("erasure forgets cached review and hire responses, so a replay cannot re-expose them", async () => {
  await withApplication("cached-replay", async (running) => {
    const candidate = "cached@example.test";
    const { reference } = await publish(running, await approvedRequisition(running));
    await request(running, `/api/adverts/${reference}/applications`, {
      role: "candidate",
      actor: candidate,
      method: "POST",
      form: application({ candidateName: "Cached Person" })
    });
    const base = `/api/requisitions/${reference}/applications/1`;
    const reviewKey = randomUUID();
    const hireKey = randomUUID();
    const reviewBody = { disposition: "shortlist", note: "Spoke to Cached" };
    const hireBody = { legalName: "Cached Person", startDate: "2026-11-02" };
    await request(running, `${base}/review`, { role: "recruiter", method: "POST", idempotencyKey: reviewKey, body: reviewBody });
    await request(running, `${base}/hire`, { role: "recruiter", method: "POST", idempotencyKey: hireKey, body: hireBody });
    await request(running, `/api/adverts/${reference}/applications/mine`, { role: "candidate", actor: candidate, method: "DELETE" });

    const replays = [
      await request(running, `${base}/review`, { role: "recruiter", method: "POST", idempotencyKey: reviewKey, body: reviewBody }),
      await request(running, `${base}/hire`, { role: "recruiter", method: "POST", idempotencyKey: hireKey, body: hireBody })
    ];
    for (const replay of replays) {
      const serialised = JSON.stringify(replay.json);
      assert.ok(!serialised.includes(candidate), `replay leaked the email: ${serialised}`);
      assert.ok(!serialised.includes("Spoke to Cached"), `replay leaked the note: ${serialised}`);
      assert.equal(replay.status, 409);
    }
  });
});

test("concurrent identical applications share one result under an exhausted rate limit", async () => {
  await withApplication(
    "concurrent",
    async (running) => {
      const { reference } = await publish(running, await approvedRequisition(running));
      const key = randomUUID();
      const send = () =>
        request(running, `/api/adverts/${reference}/applications`, {
          role: "candidate",
          actor: "twice@example.test",
          method: "POST",
          idempotencyKey: key,
          form: application()
        });
      const [first, second] = await Promise.all([send(), send()]);
      assert.equal(first?.status, 201);
      assert.equal(second?.status, 201);
      assert.deepEqual(first?.json, second?.json);
    },
    { applyRateLimit: { perCandidate: 1, perAddress: 100, windowMs: 60_000 } }
  );
});

test("upgrading a database erased before migration 7 repairs it and drops its cached responses", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentic-kodamai-upgrade-"));
  const databasePath = join(directory, "upgrade.sqlite");
  const candidate = "legacy@example.test";
  try {
    let running = await start(databasePath, { maintenanceIntervalMs: 0 });
    let reference: number;
    try {
      ({ reference } = await publish(running, await approvedRequisition(running)));
      await request(running, `/api/adverts/${reference}/applications`, {
        role: "candidate",
        actor: candidate,
        method: "POST",
        form: application()
      });
      await request(running, `/api/requisitions/${reference}/applications/1/review`, {
        role: "recruiter",
        method: "POST",
        body: { disposition: "shortlist", note: "Legacy note" }
      });
      await request(running, `/api/adverts/${reference}/applications/mine`, { role: "candidate", actor: candidate, method: "DELETE" });
    } finally {
      await running.application.close();
    }

    // Recreate the state a migration-6 erasure left behind: the email in the
    // scoring evidence and a cached review response carrying it.
    const database = new DatabaseSync(databasePath);
    database.exec(`
      DROP TRIGGER applications_erasure_only;
      UPDATE applications SET evidence_actor = '${candidate}';
      CREATE TRIGGER applications_erasure_only BEFORE UPDATE ON applications BEGIN SELECT 1; END;
      -- Replay only the repairs under test; later migrations stay applied.
      DELETE FROM schema_migrations WHERE version IN (7, 8);
    `);
    database
      .prepare(`INSERT INTO idempotency_records
        (tenant_id, actor, idempotency_key, operation, request_fingerprint, response_payload, created_at)
        VALUES ('demo', 'recruiter@example.test', 'legacy-key-1', ?, 'x', ?, ?)`)
      .run(`review-application:${reference}:1`, JSON.stringify({ note: "Legacy note", actor: candidate }), Date.now());
    database.close();

    running = await start(databasePath, { maintenanceIntervalMs: 0 });
    try {
      const listed = await request(running, `/api/requisitions/${reference}/applications`, { role: "recruiter" });
      assert.ok(!JSON.stringify(listed.json).includes(candidate));
    } finally {
      await running.application.close();
    }
    const upgraded = new DatabaseSync(databasePath);
    try {
      const cached = upgraded
        .prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE response_payload LIKE ?")
        .get(`%${candidate}%`) as { count: number };
      assert.equal(Number(cached.count), 0);
      const versions = upgraded.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
      assert.equal(Number(versions.version), 9);
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
