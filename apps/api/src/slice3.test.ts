import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { EmployeeRecord, OpenAdvert, RequisitionCase } from "../../../packages/contracts/src/index.js";
import {
  application,
  approvedRequisition,
  publish,
  request,
  withApplication,
  type RunningApplication
} from "./test-support.js";

async function reviewed(running: RunningApplication): Promise<number> {
  const advertised = await publish(running, await approvedRequisition(running));
  const reference = advertised.reference;
  for (const [actor, name] of [
    ["ada@example.test", "Ada Candidate"],
    ["grace@example.test", "Grace Candidate"],
    ["alan@example.test", "Alan Candidate"]
  ] as const) {
    await request(running, `/api/adverts/${reference}/applications`, {
      role: "candidate",
      actor,
      method: "POST",
      form: application({ candidateName: name })
    });
  }
  const decide = (id: number, body: Record<string, unknown>) =>
    request(running, `/api/requisitions/${reference}/applications/${id}/review`, {
      role: "recruiter",
      method: "POST",
      body
    });
  assert.equal((await decide(1, { disposition: "shortlist" })).status, 200);
  assert.equal((await decide(2, { disposition: "reject", reason: "Timezone" })).status, 200);
  assert.equal((await decide(3, { disposition: "shortlist" })).status, 200);
  return reference;
}

function hire(running: RunningApplication, reference: number, id: number, key = randomUUID()) {
  return request(running, `/api/requisitions/${reference}/applications/${id}/hire`, {
    role: "recruiter",
    method: "POST",
    idempotencyKey: key,
    body: { legalName: "Ada Lovelace", startDate: "2026-11-02" }
  });
}

test("hiring a shortlisted application creates a people record with provenance", async () => {
  await withApplication("hire", async (running, databasePath) => {
    const reference = await reviewed(running);

    const rejected = await hire(running, reference, 2);
    assert.deepEqual(rejected.json, { error: "not-shortlisted" });
    const byCandidate = await request(running, `/api/requisitions/${reference}/applications/1/hire`, {
      role: "candidate",
      actor: "ada@example.test",
      method: "POST",
      body: { legalName: "Ada", startDate: "2026-11-02" }
    });
    assert.equal(byCandidate.status, 403);
    const badDate = await request(running, `/api/requisitions/${reference}/applications/1/hire`, {
      role: "recruiter",
      method: "POST",
      body: { legalName: "Ada", startDate: "next week" }
    });
    assert.deepEqual(badDate.json, { error: "invalid-start-date" });

    const key = randomUUID();
    const hired = await hire(running, reference, 1, key);
    assert.equal(hired.status, 201);
    const employee = hired.json as EmployeeRecord;
    assert.equal(employee.legalName, "Ada Lovelace");
    assert.equal(employee.startDate, "2026-11-02");
    assert.deepEqual(
      { ...employee.provenance, scoring: undefined, shortlist: undefined },
      { reference, applicationId: 1, total: 46, policyVersion: "recruitment-score-v1", scoring: undefined, shortlist: undefined }
    );
    assert.equal(employee.provenance.shortlist.detail, "application:1;total:46;disposition:shortlist");
    assert.equal(employee.evidence.detail, `advert:${reference};application:1`);
    assert.equal(employee.evidence.actor, "recruiter@example.test");

    assert.deepEqual((await hire(running, reference, 1, key)).json, employee);

    // Headcount 1 is now filled: no second hire, and the advert closes.
    const second = await hire(running, reference, 3);
    assert.deepEqual(second.json, { error: "requisition-filled" });
    const row = (await request(running, `/api/requisitions/${reference}`, { role: "recruiter" })).json as RequisitionCase;
    assert.equal(row.hired, 1);
    const open = (await request(running, "/api/adverts", { role: "candidate", actor: "new@example.test" })).json as OpenAdvert[];
    assert.equal(open.length, 0);
    const late = await request(running, `/api/adverts/${reference}/applications`, {
      role: "candidate",
      actor: "new@example.test",
      method: "POST",
      form: application()
    });
    assert.equal(late.status, 409);

    const people = (await request(running, "/api/people", { role: "recruiter" })).json as EmployeeRecord[];
    assert.equal(people.length, 1);
    assert.equal(people[0]?.provenance.applicationId, 1);
    assert.equal((await request(running, "/api/people", { role: "candidate", actor: "x@example.test" })).status, 403);

    const database = new DatabaseSync(databasePath);
    try {
      assert.throws(() => database.prepare("DELETE FROM employees").run(), /provenance-immutable/u);
      assert.throws(
        () => database.prepare("UPDATE employees SET application_id = 3").run(),
        /provenance-immutable/u
      );
    } finally {
      database.close();
    }
  });
});

test("a hire is refused when the stored shortlist no longer reproduces", async () => {
  await withApplication("hire-tamper", async (running, databasePath) => {
    const reference = await reviewed(running);
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("DROP TRIGGER application_reviews_erasure_only");
      database.prepare("UPDATE application_reviews SET detail = 'application:1;total:49;disposition:shortlist' WHERE application_id = 1").run();
    } finally {
      database.close();
    }
    const refused = await hire(running, reference, 1);
    assert.equal(refused.status, 500);
    assert.deepEqual((await request(running, "/api/people", { role: "recruiter" })).json, []);
  });
});
