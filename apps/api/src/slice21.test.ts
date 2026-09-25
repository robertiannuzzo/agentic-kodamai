import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ApplicationRecord, ApplicationReview } from "../../../packages/contracts/src/index.js";
import {
  application,
  approvedRequisition,
  publish,
  request,
  withApplication,
  type RunningApplication
} from "./test-support.js";

const day = 24 * 60 * 60 * 1000;

async function advertWithApplicants(running: RunningApplication): Promise<number> {
  const advertised = await publish(running, await approvedRequisition(running));
  for (const [actor, name] of [
    ["ada@example.test", "Ada Candidate"],
    ["grace@example.test", "Grace Candidate"]
  ] as const) {
    const applied = await request(running, `/api/adverts/${advertised.reference}/applications`, {
      role: "candidate",
      actor,
      method: "POST",
      form: application({ candidateName: name })
    });
    assert.equal(applied.status, 201);
  }
  return advertised.reference;
}

async function records(running: RunningApplication, reference: number): Promise<ApplicationRecord[]> {
  const listed = await request(running, `/api/requisitions/${reference}/applications`, { role: "recruiter" });
  assert.equal(listed.status, 200);
  return listed.json as ApplicationRecord[];
}

test("a recruiter's decision is recorded once, as kernel evidence against the re-derived score", async () => {
  await withApplication("review", async (running) => {
    const reference = await advertWithApplicants(running);
    const path = `/api/requisitions/${reference}/applications/1/review`;

    const byCandidate = await request(running, path, {
      role: "candidate",
      actor: "ada@example.test",
      method: "POST",
      body: { disposition: "shortlist" }
    });
    assert.equal(byCandidate.status, 403);

    const shortlisted = await request(running, path, {
      role: "recruiter",
      method: "POST",
      body: { disposition: "shortlist", note: "Strong Idris background." }
    });
    assert.equal(shortlisted.status, 200);
    const review = shortlisted.json as ApplicationReview;
    assert.equal(review.disposition, "shortlist");
    assert.equal(review.evidence.detail, "application:1;total:46;disposition:shortlist");
    assert.equal(review.evidence.actor, "recruiter@example.test");

    const again = await request(running, path, {
      role: "recruiter",
      method: "POST",
      body: { disposition: "reject", reason: "Changed my mind" }
    });
    assert.deepEqual(again.json, { error: "already-reviewed" });

    const noReason = await request(running, `/api/requisitions/${reference}/applications/2/review`, {
      role: "recruiter",
      method: "POST",
      body: { disposition: "reject", reason: " " }
    });
    assert.equal(noReason.status, 400);
    assert.deepEqual(noReason.json, { error: "reason-required" });

    const [ada] = await records(running, reference);
    assert.equal(ada?.review?.note, "Strong Idris background.");
  });
});

test("a stored score the policy cannot reproduce is not reviewed", async () => {
  await withApplication("drift", async (running, databasePath) => {
    const reference = await advertWithApplicants(running);
    const database = new DatabaseSync(databasePath);
    try {
      assert.throws(
        () => database.prepare("UPDATE applications SET keywords = 50 WHERE application_id = 1").run(),
        /application-immutable/u
      );
      database.exec("DROP TRIGGER applications_erasure_only");
      database.prepare("UPDATE applications SET keywords = 50 WHERE application_id = 1").run();
    } finally {
      database.close();
    }
    const refused = await request(running, `/api/requisitions/${reference}/applications/1/review`, {
      role: "recruiter",
      method: "POST",
      body: { disposition: "shortlist" }
    });
    assert.equal(refused.status, 500);
    assert.equal((await records(running, reference))[0]?.review, null);
  });
});

test("candidates can withdraw and recruiters can erase; scores and evidence survive anonymised", async () => {
  await withApplication("erasure", async (running, databasePath) => {
    const reference = await advertWithApplicants(running);
    await request(running, `/api/requisitions/${reference}/applications/2/review`, {
      role: "recruiter",
      method: "POST",
      body: { disposition: "reject", reason: "Grace prefers remote", note: "Spoke to Grace on the phone" }
    });

    const withdrawn = await request(running, `/api/adverts/${reference}/applications/mine`, {
      role: "candidate",
      actor: "ada@example.test",
      method: "DELETE"
    });
    assert.equal(withdrawn.status, 204);
    const again = await request(running, `/api/adverts/${reference}/applications/mine`, {
      role: "candidate",
      actor: "ada@example.test",
      method: "DELETE"
    });
    assert.equal(again.status, 404);

    const noReason = await request(running, `/api/requisitions/${reference}/applications/2/erase`, {
      role: "recruiter",
      method: "POST",
      body: {}
    });
    assert.equal(noReason.status, 400);
    const erased = await request(running, `/api/requisitions/${reference}/applications/2/erase`, {
      role: "recruiter",
      method: "POST",
      body: { reason: "Erasure request by email" }
    });
    assert.equal(erased.status, 204);

    const list = await records(running, reference);
    for (const record of list) {
      assert.equal(record.candidateName, "Erased candidate");
      assert.equal(record.cvText, "");
      assert.ok(record.answers.every(({ answer }) => answer === ""));
      assert.equal(record.total, 46);
      assert.ok(record.erasedAt !== null);
    }
    const grace = list.find(({ applicationId }) => applicationId === 2);
    assert.equal(grace?.erasureReason, "Erasure request by email");
    assert.equal(grace?.review?.disposition, "reject");
    assert.equal(grace?.review?.reason, "");
    assert.equal(grace?.review?.note, "");
    assert.equal(grace?.review?.evidence.detail, "application:2;total:46;disposition:reject");

    const reviewErased = await request(running, `/api/requisitions/${reference}/applications/1/review`, {
      role: "recruiter",
      method: "POST",
      body: { disposition: "shortlist" }
    });
    assert.deepEqual(reviewErased.json, { error: "application-erased" });

    const database = new DatabaseSync(databasePath);
    try {
      const keys = database
        .prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE actor LIKE '%@example.test' AND operation LIKE 'apply:%'")
        .get() as { count: number };
      assert.equal(Number(keys.count), 0);
      assert.throws(
        () => database.prepare("UPDATE applications SET candidate_name = 'Ada' WHERE application_id = 1").run(),
        /application-immutable/u
      );
    } finally {
      database.close();
    }

    const reapplied = await request(running, `/api/adverts/${reference}/applications`, {
      role: "candidate",
      actor: "ada@example.test",
      method: "POST",
      form: application()
    });
    assert.equal(reapplied.status, 201);
  });
});

test("retention anonymises old applications and idempotency keys expire", async () => {
  await withApplication(
    "retention",
    async (running) => {
      const reference = await advertWithApplicants(running);
      const now = Date.now();
      assert.deepEqual(running.application.maintain(now + 29 * day), { purged: 0, pruned: 0 });
      const later = running.application.maintain(now + 31 * day);
      assert.equal(later.purged, 2);
      assert.ok(later.pruned > 0);
      const list = await records(running, reference);
      assert.ok(list.every(({ erasureReason }) => erasureReason === "retention period ended"));
    },
    { retentionDays: 30, idempotencyTtlMs: 30 * day }
  );
});

test("the public application endpoint is rate limited per candidate", async () => {
  await withApplication(
    "rate",
    async (running) => {
      const advertised = await publish(running, await approvedRequisition(running));
      const path = `/api/adverts/${advertised.reference}/applications`;
      const attempt = () =>
        request(running, path, { role: "candidate", actor: "spam@example.test", method: "POST", form: application() });
      assert.equal((await attempt()).status, 201);
      assert.equal((await attempt()).status, 409);
      const limited = await attempt();
      assert.equal(limited.status, 429);
      assert.deepEqual(limited.json, { error: "rate-limited" });
    },
    { applyRateLimit: { perCandidate: 2, perAddress: 100, windowMs: 60_000 } }
  );
});
