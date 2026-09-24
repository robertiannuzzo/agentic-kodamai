import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type {
  ApplicationAcknowledgement,
  ApplicationRecord,
  OpenAdvert,
  RequisitionCase
} from "../../../packages/contracts/src/index.js";
import { request, start, type RunningApplication } from "./test-support.js";

const schema = {
  questions: [
    { prompt: "Can you work in this time zone?", expected: "yes" },
    { prompt: "Do you use typed programming?", expected: "yes" }
  ],
  skills: [
    { keyword: "idris", weight: 3, targetYears: 5 },
    { keyword: "sql", weight: 2, targetYears: 3 }
  ]
};

function application(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidateName: "Ada Candidate",
    cvText: "Idris and SQL experience",
    consent: true,
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

async function withApplication(
  name: string,
  body: (running: RunningApplication, databasePath: string) => Promise<void>
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `agentic-kodamai-${name}-`));
  const databasePath = join(directory, "slice2.sqlite");
  const running = await start(databasePath);
  try {
    await body(running, databasePath);
  } finally {
    await running.application.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function approvedRequisition(running: RunningApplication): Promise<RequisitionCase> {
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

async function publish(running: RunningApplication, row: RequisitionCase): Promise<RequisitionCase> {
  const published = await request(running, `/api/requisitions/${row.reference}/advert`, {
    method: "POST",
    role: "recruiter",
    body: { generation: row.generation, ...schema }
  });
  assert.equal(published.status, 200);
  return published.json as RequisitionCase;
}

test("a recruiter publishes a frozen advert and applications are scored by the kernel", async () => {
  await withApplication("advert", async (running, databasePath) => {
    const approved = await approvedRequisition(running);

    const byRequester = await request(running, `/api/requisitions/${approved.reference}/advert`, {
      method: "POST",
      body: { generation: approved.generation, ...schema }
    });
    assert.equal(byRequester.status, 403);

    const advertised = await publish(running, approved);
    assert.equal(advertised.stage, "advertising");
    assert.deepEqual(
      advertised.advert?.questions.map(({ questionId }) => questionId),
      [1, 2]
    );
    const publication = advertised.history.at(-1);
    assert.equal(publication?.event, "advert-created");
    assert.match(publication?.detail ?? "", /^advert:\d+;schema:[0-9a-f]{16}$/u);

    const again = await request(running, `/api/requisitions/${approved.reference}/advert`, {
      method: "POST",
      role: "recruiter",
      body: { generation: advertised.generation, ...schema }
    });
    assert.equal(again.status, 409);
    assert.deepEqual(again.json, { error: "wrong-stage" });

    // Candidates see a smaller response: no expected answers, weights or budget.
    const candidate = { role: "candidate" as const, actor: "ada@example.test" };
    const open = await request(running, "/api/adverts", candidate);
    assert.equal(open.status, 200);
    const [advert] = open.json as OpenAdvert[];
    assert.deepEqual(advert, {
      reference: approved.reference,
      role: "Typed Systems Engineer",
      department: "Engineering",
      questions: [
        { questionId: 1, prompt: "Can you work in this time zone?" },
        { questionId: 2, prompt: "Do you use typed programming?" }
      ],
      skills: [
        { skillId: 1, keyword: "idris" },
        { skillId: 2, keyword: "sql" }
      ],
      applied: false
    });
    assert.equal((await request(running, "/api/requisitions", candidate)).status, 403);

    const path = `/api/adverts/${approved.reference}/applications`;
    const noConsent = await request(running, path, {
      ...candidate,
      method: "POST",
      body: application({ consent: false })
    });
    assert.deepEqual(noConsent.json, { error: "consent-required" });

    const key = randomUUID();
    const applied = await request(running, path, {
      ...candidate,
      method: "POST",
      idempotencyKey: key,
      body: application()
    });
    assert.equal(applied.status, 201);
    assert.deepEqual(applied.json, {
      reference: approved.reference,
      applicationId: 1,
      status: "received"
    } satisfies ApplicationAcknowledgement);

    const retried = await request(running, path, {
      ...candidate,
      method: "POST",
      idempotencyKey: key,
      body: application()
    });
    assert.deepEqual(retried.json, applied.json);
    const duplicate = await request(running, path, { ...candidate, method: "POST", body: application() });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(duplicate.json, { error: "already-applied" });

    const mismatched = await request(running, path, {
      role: "candidate",
      actor: "bob@example.test",
      method: "POST",
      body: application({ answers: [{ questionId: 2, answer: "yes" }, { questionId: 1, answer: "yes" }] })
    });
    assert.equal(mismatched.status, 400);
    assert.deepEqual(mismatched.json, { error: "answers-do-not-match-questions" });

    await running.application.close();
    // withApplication closes the original instance again; make that a no-op.
    running.application.close = async () => undefined;
    const reopened = await start(databasePath);
    try {
      // After restart the advert is rebuilt by replay before the kernel scores.
      const second = await request(reopened, path, {
        role: "candidate",
        actor: "grace@example.test",
        method: "POST",
        body: application({
          candidateName: "Grace Candidate",
          cvText: "Haskell",
          answers: [
            { questionId: 1, answer: "no" },
            { questionId: 2, answer: "yes" }
          ],
          years: [
            { skillId: 1, years: 1 },
            { skillId: 2, years: 1 }
          ]
        })
      });
      assert.equal(second.status, 201);

      assert.equal((await request(reopened, `/api/requisitions/${approved.reference}/applications`)).status, 403);
      const listed = await request(reopened, `/api/requisitions/${approved.reference}/applications`, {
        role: "recruiter"
      });
      const records = listed.json as ApplicationRecord[];
      assert.deepEqual(
        records.map(({ candidateName, total }) => [candidateName, total]),
        [
          ["Ada Candidate", 46],
          ["Grace Candidate", 18]
        ]
      );
      const [ada] = records;
      assert.deepEqual(ada?.breakdown, { keywords: 5, experience: 18, screening: 20, completeness: 3 });
      assert.equal(ada?.policyVersion, "recruitment-score-v1");
      assert.equal(
        ada?.evidence.detail,
        `advert:${approved.reference};application:1;policy:recruitment-score-v1`
      );
      assert.equal(ada?.answers[0]?.expected, "yes");
      assert.equal(ada?.experience[1]?.years, 8);

      const openAfter = await request(reopened, "/api/adverts", candidate);
      assert.equal((openAfter.json as OpenAdvert[])[0]?.applied, true);
    } finally {
      await reopened.application.close();
    }
  });
});

test("a published schema is frozen in the database and checked again on replay", async () => {
  await withApplication("frozen", async (running, databasePath) => {
    const advertised = await publish(running, await approvedRequisition(running));
    const database = new DatabaseSync(databasePath);
    try {
      assert.throws(
        () => database.prepare("UPDATE advert_questions SET expected = 'no' WHERE ordinal = 0").run(),
        /advert-frozen/u
      );
      assert.throws(() => database.prepare("DELETE FROM advert_skills").run(), /advert-frozen/u);

      // Bypass the trigger as a hostile or mistaken maintainer could.
      database.exec("DROP TRIGGER advert_questions_frozen_update");
      database.prepare("UPDATE advert_questions SET expected = 'no' WHERE ordinal = 0").run();
    } finally {
      database.close();
    }

    const refused = await request(running, `/api/adverts/${advertised.reference}/applications`, {
      role: "candidate",
      actor: "ada@example.test",
      method: "POST",
      body: application()
    });
    assert.equal(refused.status, 500);
    const listed = await request(running, `/api/requisitions/${advertised.reference}/applications`, {
      role: "recruiter"
    });
    assert.deepEqual(listed.json, []);
  });
});

test("scored applications are immutable", async () => {
  await withApplication("immutable", async (running, databasePath) => {
    const advertised = await publish(running, await approvedRequisition(running));
    const applied = await request(running, `/api/adverts/${advertised.reference}/applications`, {
      role: "candidate",
      actor: "ada@example.test",
      method: "POST",
      body: application()
    });
    assert.equal(applied.status, 201);
    const database = new DatabaseSync(databasePath);
    try {
      assert.throws(() => database.prepare("UPDATE applications SET total = 100").run(), /application-immutable/u);
      assert.throws(() => database.prepare("DELETE FROM application_answers").run(), /application-immutable/u);
    } finally {
      database.close();
    }
  });
});
