import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ApplicationRecord, RequisitionCase } from "../../../packages/contracts/src/index.js";
import {
  application,
  approvedRequisition,
  pdf,
  publish,
  request,
  schema,
  start,
  withApplication,
  type RunningApplication
} from "./test-support.js";

function withDatabase<T>(path: string, work: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(path);
  try {
    return work(database);
  } finally {
    database.close();
  }
}

async function draft(running: RunningApplication, role: string): Promise<RequisitionCase> {
  const created = await request(running, "/api/requisitions", {
    method: "POST",
    body: { fields: { role, department: "Engineering", headcount: 1, budgetMinor: 100, justification: "Needed" } }
  });
  assert.equal(created.status, 201);
  return created.json as RequisitionCase;
}

async function stored(running: RunningApplication, reference: number): Promise<RequisitionCase> {
  return (await request(running, `/api/requisitions/${reference}`, { role: "recruiter" })).json as RequisitionCase;
}

test("an idempotency key reused for another requisition is a conflict, not the first reply", async () => {
  await withApplication("idempotency-target", async (running) => {
    const first = await draft(running, "First role");
    const second = await draft(running, "Second role");
    const key = randomUUID();
    const submit = (row: RequisitionCase) =>
      request(running, `/api/requisitions/${row.reference}/submit`, {
        method: "POST",
        idempotencyKey: key,
        body: { generation: row.generation }
      });

    const submitted = await submit(first);
    assert.equal(submitted.status, 200);
    // The same request again replays its reply.
    assert.deepEqual(await submit(first), submitted);
    // The same key and body aimed at another requisition must not return the
    // first requisition's reply as if the second had been submitted.
    const reused = await submit(second);
    assert.equal(reused.status, 409);
    assert.deepEqual(reused.json, { error: "idempotency-key-conflict" });
    assert.equal((await stored(running, second.reference)).stage, "draft");

    // Ownership and role checks still apply before any cached reply.
    const byOther = await request(running, `/api/requisitions/${first.reference}/submit`, {
      method: "POST",
      actor: "someone-else@example.test",
      idempotencyKey: key,
      body: { generation: first.generation }
    });
    assert.equal(byOther.status, 404);
    const byApprover = await request(running, `/api/requisitions/${first.reference}/submit`, {
      method: "POST",
      role: "approver",
      idempotencyKey: key,
      body: { generation: first.generation }
    });
    assert.equal(byApprover.status, 403);
  });
});

const tamperings: Array<[string, string, string | number]> = [
  ["role", "role", "A different job"],
  ["department", "department", "A different department"],
  ["headcount", "headcount", 999],
  ["budget", "budget_minor", 999999999],
  ["justification", "justification", "A different reason"]
];

test("an approval binds every submitted field: changing any one blocks publication", async () => {
  await withApplication("snapshot-publish", async (running, databasePath) => {
    for (const [label, column, value] of tamperings) {
      const approved = await approvedRequisition(running);
      withDatabase(databasePath, (database) =>
        database.prepare(`UPDATE requisitions SET ${column} = ? WHERE reference = ?`).run(value, approved.reference)
      );
      const published = await request(running, `/api/requisitions/${approved.reference}/advert`, {
        method: "POST",
        role: "recruiter",
        body: { generation: approved.generation, ...schema }
      });
      assert.equal(published.status, 500, label);
      const after = await stored(running, approved.reference);
      assert.equal(after.stage, "approved", label);
      assert.equal(after.history.length, approved.history.length, label);
    }
  });
});

test("a changed field on a published advert blocks applications and decisions", async () => {
  await withApplication("snapshot-advert", async (running, databasePath) => {
    const advertised = await publish(running, await approvedRequisition(running));
    const path = `/api/adverts/${advertised.reference}/applications`;
    const applied = await request(running, path, {
      role: "candidate",
      actor: "ada@example.test",
      method: "POST",
      form: application()
    });
    assert.equal(applied.status, 201);
    withDatabase(databasePath, (database) =>
      database.prepare("UPDATE requisitions SET budget_minor = 1 WHERE reference = ?").run(advertised.reference)
    );
    const late = await request(running, path, {
      role: "candidate",
      actor: "grace@example.test",
      method: "POST",
      form: application()
    });
    assert.equal(late.status, 500);
    const review = await request(running, `/api/requisitions/${advertised.reference}/applications/1/review`, {
      method: "POST",
      role: "recruiter",
      body: { disposition: "shortlist" }
    });
    assert.equal(review.status, 500);
    const listed = await request(running, `/api/requisitions/${advertised.reference}/applications`, { role: "recruiter" });
    const records = listed.json as ApplicationRecord[];
    assert.equal(records.length, 1);
    assert.equal(records[0]?.review, null);
  });
});

test("multiline and Unicode fields survive the snapshot through rework and restart", async () => {
  await withApplication("snapshot-unicode", async (running, databasePath) => {
    const fields = {
      role: "Ingénieur·e 🎼, typed: systems",
      department: "R&D, 1:2",
      headcount: 2,
      budgetMinor: 123456,
      justification: "Line one,\nline two: ünïcode 🎼"
    };
    const created = await request(running, "/api/requisitions", { method: "POST", body: { fields } });
    let row = created.json as RequisitionCase;
    row = (await request(running, `/api/requisitions/${row.reference}/submit`, { method: "POST", body: { generation: row.generation } })).json as RequisitionCase;
    row = (await request(running, `/api/requisitions/${row.reference}/review`, {
      method: "POST",
      role: "approver",
      body: { generation: row.generation, decision: "hold", reason: "Smaller, please" }
    })).json as RequisitionCase;
    const revised = { ...fields, headcount: 1, justification: `${fields.justification}\nrevised` };
    const resubmitted = await request(running, `/api/requisitions/${row.reference}/resubmit`, {
      method: "POST",
      body: { generation: row.generation, fields: revised }
    });
    assert.equal(resubmitted.status, 200);
    row = resubmitted.json as RequisitionCase;

    await running.application.close();
    running.application.close = async () => undefined;
    const reopened = await start(databasePath);
    try {
      const approved = await request(reopened, `/api/requisitions/${row.reference}/review`, {
        method: "POST",
        role: "approver",
        body: { generation: row.generation, decision: "approve", reason: "" }
      });
      assert.equal(approved.status, 200);
      const published = await publish(reopened, approved.json as RequisitionCase);
      assert.equal(published.stage, "advertising");
      assert.equal(published.role, fields.role);
      assert.equal(published.justification, revised.justification);
    } finally {
      await reopened.application.close();
    }
  });
});

/** Rewrite a requisition's audit trail into the form earlier releases stored. */
function toLegacyEvidence(databasePath: string, reference: number): void {
  withDatabase(databasePath, (database) =>
    database
      .prepare(`UPDATE audit_entries
        SET detail = (SELECT justification FROM requisitions WHERE requisitions.reference = audit_entries.reference)
        WHERE reference = ? AND event IN ('draft-created', 'draft-updated', 'submitted')`)
      .run(reference)
  );
}

test("requisitions recorded before full-field snapshots keep working, checked on their justification", async () => {
  await withApplication("snapshot-legacy", async (running, databasePath) => {
    // An advert with an applicant, an approved requisition and a draft, all
    // recorded the old way.
    const advertised = await publish(running, await approvedRequisition(running));
    assert.equal(
      (await request(running, `/api/adverts/${advertised.reference}/applications`, {
        role: "candidate",
        actor: "ada@example.test",
        method: "POST",
        form: application()
      })).status,
      201
    );
    const approved = await approvedRequisition(running);
    const oldDraft = await draft(running, "Old draft");
    for (const reference of [advertised.reference, approved.reference, oldDraft.reference]) {
      toLegacyEvidence(databasePath, reference);
    }
    const legacyDetail = withDatabase(databasePath, (database) =>
      (database.prepare("SELECT detail FROM audit_entries WHERE reference = ? AND event = 'submitted'").get(approved.reference) as { detail: string }).detail
    );
    assert.equal(legacyDetail, "Build recruitment tools");

    await running.application.close();
    running.application.close = async () => undefined;
    const reopened = await start(databasePath);
    try {
      // Existing applicants can still be decided on and new ones can apply.
      const reviewed = await request(reopened, `/api/requisitions/${advertised.reference}/applications/1/review`, {
        method: "POST",
        role: "recruiter",
        body: { disposition: "shortlist" }
      });
      assert.equal(reviewed.status, 200);
      assert.equal(
        (await request(reopened, `/api/adverts/${advertised.reference}/applications`, {
          role: "candidate",
          actor: "grace@example.test",
          method: "POST",
          form: application()
        })).status,
        201
      );
      // The approved requisition can be published.
      assert.equal((await publish(reopened, approved)).stage, "advertising");
      // The draft saves and submits with the full snapshot from now on.
      const saved = await request(reopened, `/api/requisitions/${oldDraft.reference}`, {
        method: "PUT",
        body: { generation: oldDraft.generation, fields: { ...oldDraft, role: "Renamed draft" } }
      });
      assert.equal(saved.status, 200);
      const submitted = await request(reopened, `/api/requisitions/${oldDraft.reference}/submit`, {
        method: "POST",
        body: { generation: (saved.json as RequisitionCase).generation }
      });
      assert.equal(submitted.status, 200);
      assert.match((submitted.json as RequisitionCase).history.at(-1)?.detail ?? "", /^requisition-fields-v1:/u);

      // The weaker check still refuses a changed justification.
      withDatabase(databasePath, (database) =>
        database.prepare("UPDATE requisitions SET justification = 'Changed' WHERE reference = ?").run(advertised.reference)
      );
      const refused = await request(reopened, `/api/adverts/${advertised.reference}/applications`, {
        role: "candidate",
        actor: "max@example.test",
        method: "POST",
        form: application()
      });
      assert.equal(refused.status, 500);
    } finally {
      await reopened.application.close();
    }
  });
});

const day = 24 * 60 * 60 * 1000;

/** Every byte SQLite keeps for this database: the file and any journal. */
function onDisk(databasePath: string): Buffer {
  return Buffer.concat(
    ["", "-journal", "-wal", "-shm"]
      .map((suffix) => `${databasePath}${suffix}`)
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path))
  );
}

function assertAbsent(databasePath: string, markers: string[]): void {
  const bytes = onDisk(databasePath);
  for (const marker of markers) {
    assert.equal(bytes.includes(Buffer.from(marker)), false, `${marker} is still on disk`);
  }
}

test("erased personal data does not remain in the database file", async () => {
  await withApplication(
    "erasure-on-disk",
    async (running, databasePath) => {
      const advertised = await publish(running, await approvedRequisition(running));
      const path = `/api/adverts/${advertised.reference}/applications`;
      const markers = new Map<string, string[]>();
      for (const who of ["withdrawn", "erased", "expired"]) {
        const tag = `${who.toUpperCase()}-${randomUUID()}`;
        const mine = [`Name-${tag}`, `CV-${tag}`, `Letter-${tag}`, `Answer-${tag}`];
        markers.set(who, mine);
        const applied = await request(running, path, {
          role: "candidate",
          actor: `${who}@example.test`,
          method: "POST",
          form: application({
            candidateName: mine[0],
            coverLetterText: mine[2],
            answers: [
              { questionId: 1, answer: mine[3] },
              { questionId: 2, answer: "yes" }
            ]
          }),
          cv: [pdf([`Idris and SQL ${mine[1]}`])]
        });
        assert.equal(applied.status, 201);
      }
      // Present before erasure, so the scan can see them.
      assert.ok(onDisk(databasePath).includes(Buffer.from(markers.get("withdrawn")?.[1] ?? "")));
      const before = (await request(running, `/api/requisitions/${advertised.reference}/applications`, { role: "recruiter" }))
        .json as ApplicationRecord[];

      assert.equal(
        (await request(running, `${path}/mine`, { role: "candidate", actor: "withdrawn@example.test", method: "DELETE" })).status,
        204
      );
      assertAbsent(databasePath, markers.get("withdrawn") ?? []);
      assert.equal(
        (await request(running, `/api/requisitions/${advertised.reference}/applications/2/erase`, {
          role: "recruiter",
          method: "POST",
          body: { reason: "Asked by email" }
        })).status,
        204
      );
      assertAbsent(databasePath, markers.get("erased") ?? []);
      assert.equal(running.application.maintain(Date.now() + 31 * day).purged, 1);
      assertAbsent(databasePath, [...markers.values()].flat());

      // Scores and evidence remain.
      const after = (await request(running, `/api/requisitions/${advertised.reference}/applications`, { role: "recruiter" }))
        .json as ApplicationRecord[];
      assert.deepEqual(
        after.map(({ applicationId, total, evidence }) => [applicationId, total, evidence.detail]),
        before.map(({ applicationId, total, evidence }) => [applicationId, total, evidence.detail])
      );

      // Still absent once the server has stopped and started again.
      await running.application.close();
      running.application.close = async () => undefined;
      assertAbsent(databasePath, [...markers.values()].flat());
      const reopened = await start(databasePath);
      await reopened.application.close();
      assertAbsent(databasePath, [...markers.values()].flat());
    },
    { retentionDays: 30 }
  );
});

test("a database from an earlier release is scrubbed of data it had already deleted", async () => {
  await withApplication("erasure-upgrade", async (running, databasePath) => {
    await running.application.close();
    running.application.close = async () => undefined;
    // Recreate what an earlier release left: WAL mode, no secure_delete, and a
    // deleted row whose bytes are still in a free page.
    const marker = `DELETED-${randomUUID()}`;
    withDatabase(databasePath, (database) => {
      database.exec("PRAGMA secure_delete = OFF; PRAGMA journal_mode = WAL; PRAGMA user_version = 0");
      database
        .prepare(`INSERT INTO idempotency_records
          (tenant_id, actor, idempotency_key, operation, request_fingerprint, response_payload, created_at)
          VALUES ('demo', 'someone', 'key-12345', 'op', 'x', ?, 0)`)
        .run(marker.repeat(200));
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      database.prepare("DELETE FROM idempotency_records").run();
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    });
    assert.ok(onDisk(databasePath).includes(Buffer.from(marker)), "the fixture should leave the deleted bytes behind");

    const upgraded = await start(databasePath);
    await upgraded.application.close();
    assertAbsent(databasePath, [marker]);
    withDatabase(databasePath, (database) => {
      assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
      assert.equal((database.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "delete");
    });
  });
});
