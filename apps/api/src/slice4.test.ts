import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ApplicationRecord, DemoRole } from "../../../packages/contracts/src/index.js";
import {
  application,
  approvedRequisition,
  pdf,
  publish,
  request,
  withApplication,
  type RunningApplication
} from "./test-support.js";

const day = 24 * 60 * 60 * 1000;

async function advert(running: RunningApplication): Promise<number> {
  return (await publish(running, await approvedRequisition(running))).reference;
}

function apply(
  running: RunningApplication,
  reference: number,
  actor: string,
  overrides: Record<string, unknown> = {},
  cv?: Buffer[],
  idempotencyKey?: string
): Promise<{ status: number; json: unknown }> {
  return request(running, `/api/adverts/${reference}/applications`, {
    role: "candidate",
    actor,
    method: "POST",
    form: application(overrides),
    ...(cv === undefined ? {} : { cv }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey })
  });
}

async function records(running: RunningApplication, reference: number): Promise<ApplicationRecord[]> {
  const listed = await request(running, `/api/requisitions/${reference}/applications`, { role: "recruiter" });
  assert.equal(listed.status, 200);
  return listed.json as ApplicationRecord[];
}

async function fetchCv(
  running: RunningApplication,
  reference: number,
  applicationId: number,
  role: DemoRole = "recruiter",
  tenantId = "demo"
): Promise<Response> {
  return fetch(`${running.origin}/api/requisitions/${reference}/applications/${applicationId}/cv`, {
    headers: { "x-demo-role": role, "x-demo-actor": `${role}@example.test`, "x-demo-tenant": tenantId }
  });
}

function documentCount(databasePath: string): number {
  const database = new DatabaseSync(databasePath);
  try {
    return Number((database.prepare("SELECT COUNT(*) AS count FROM documents").get() as { count: number }).count);
  } finally {
    database.close();
  }
}

test("a PDF CV is read, scored like pasted text, and kept privately for recruiters", async () => {
  await withApplication("pdf-cv", async (running, databasePath) => {
    const reference = await advert(running);
    const cv = pdf(["Idris and SQL experience"]);
    const applied = await apply(running, reference, "ada@example.test", {}, [cv]);
    assert.equal(applied.status, 201);

    const [record] = await records(running, reference);
    assert.equal(record?.cvText, "Idris and SQL experience");
    assert.equal(record?.hasCvDocument, true);
    assert.equal(record?.coverLetterText, null);
    // The same breakdown the pasted text "Idris and SQL experience" produced.
    assert.deepEqual(record?.breakdown, { keywords: 5, experience: 18, screening: 20, completeness: 3 });
    assert.match(record?.cvVersion ?? "", /^[0-9a-f]{64}$/u);

    const opened = await fetchCv(running, reference, 1);
    assert.equal(opened.status, 200);
    assert.equal(opened.headers.get("content-type"), "application/pdf");
    assert.equal(opened.headers.get("content-disposition"), `inline; filename="cv-${reference}-1.pdf"`);
    assert.equal(opened.headers.get("x-content-type-options"), "nosniff");
    assert.match(opened.headers.get("content-security-policy") ?? "", /default-src 'none'/u);
    assert.deepEqual(Buffer.from(await opened.arrayBuffer()), cv);

    // Only recruiters in the same tenant can open it.
    for (const role of ["requester", "approver", "candidate"] as const) {
      assert.equal((await fetchCv(running, reference, 1, role)).status, 403);
    }
    assert.equal((await fetchCv(running, reference, 1, "recruiter", "other")).status, 404);
    assert.equal((await fetchCv(running, reference, 2)).status, 404);
    assert.equal(documentCount(databasePath), 1);
  });
});

test("unusable CV uploads are refused with a reason and leave nothing behind", async () => {
  await withApplication("pdf-refusals", async (running, databasePath) => {
    const reference = await advert(running);
    const refusals: Array<[Buffer[], number, string]> = [
      [[], 400, "cv-required"],
      [[pdf(["one"]), pdf(["two"])], 400, "too-many-cvs"],
      [[Buffer.from("This is a Word document renamed to .pdf")], 400, "cv-not-pdf"],
      [[Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(5 * 1024 * 1024)])], 413, "cv-too-large"],
      [[Buffer.from("%PDF-1.4 not really a PDF")], 400, "cv-unreadable"],
      [[pdf([])], 400, "cv-no-text"]
    ];
    for (const [cv, status, error] of refusals) {
      const refused = await apply(running, reference, "ada@example.test", {}, cv);
      assert.equal(refused.status, status, error);
      assert.deepEqual(refused.json, { error });
    }

    // A JSON body with pasted text is no longer an application.
    const pasted = await request(running, `/api/adverts/${reference}/applications`, {
      role: "candidate",
      actor: "ada@example.test",
      method: "POST",
      body: application()
    });
    assert.equal(pasted.status, 415);

    assert.equal(documentCount(databasePath), 0);
    // Refused uploads did not use up an application number.
    const applied = await apply(running, reference, "ada@example.test");
    assert.deepEqual(applied.json, { reference, applicationId: 1, status: "received" });
  }, { applyRateLimit: { perCandidate: 100, perAddress: 100, windowMs: 60_000 } });
});

test("a kernel refusal and a replayed upload do not store extra documents", async () => {
  await withApplication("pdf-idempotency", async (running, databasePath) => {
    const reference = await advert(running);
    const mismatched = await apply(running, reference, "ada@example.test", {
      answers: [{ questionId: 1, answer: "yes" }]
    });
    assert.deepEqual(mismatched.json, { error: "answers-do-not-match-questions" });
    assert.equal(documentCount(databasePath), 0);

    const key = randomUUID();
    const first = await apply(running, reference, "ada@example.test", {}, undefined, key);
    const replayed = await apply(running, reference, "ada@example.test", {}, undefined, key);
    assert.equal(first.status, 201);
    assert.deepEqual(replayed.json, first.json);
    assert.equal(documentCount(databasePath), 1);

    // The same key with a different file is a different request.
    const changed = await apply(running, reference, "ada@example.test", {}, [pdf(["Other CV"])], key);
    assert.deepEqual(changed.json, { error: "idempotency-key-conflict" });
    assert.equal(documentCount(databasePath), 1);
  });
});

test("the cover letter is optional, trimmed, limited to 5,000 characters and never scored", async () => {
  await withApplication("cover-letter", async (running) => {
    const reference = await advert(running);
    const tooLong = await apply(running, reference, "long@example.test", { coverLetterText: "a".repeat(5001) });
    assert.deepEqual(tooLong.json, { error: "cover-letter-too-long" });

    const letter = "Idris idris SQL sql. I have used both for years.";
    assert.equal((await apply(running, reference, "ada@example.test", { coverLetterText: `\n  ${letter}  \n` })).status, 201);
    assert.equal((await apply(running, reference, "grace@example.test", { coverLetterText: "   \n " })).status, 201);
    assert.equal((await apply(running, reference, "max@example.test", { coverLetterText: "é".repeat(5000) })).status, 201);
    assert.equal((await apply(running, reference, "none@example.test")).status, 201);

    const byActor = new Map((await records(running, reference)).map((r) => [r.candidateActor, r]));
    assert.equal(byActor.get("ada@example.test")?.coverLetterText, letter);
    assert.equal(byActor.get("grace@example.test")?.coverLetterText, null);
    assert.equal(byActor.get("max@example.test")?.coverLetterText, "é".repeat(5000));
    assert.equal(byActor.get("none@example.test")?.coverLetterText, null);
    // Keywords in the cover letter do not move the score.
    assert.deepEqual(byActor.get("ada@example.test")?.breakdown, byActor.get("none@example.test")?.breakdown);
    assert.equal(byActor.get("ada@example.test")?.total, byActor.get("none@example.test")?.total);
  });
});

test("withdrawal, erasure and retention delete the PDF and the cover letter, not the score", async () => {
  await withApplication(
    "pdf-erasure",
    async (running, databasePath) => {
      const reference = await advert(running);
      for (const actor of ["withdraw@example.test", "erase@example.test", "expire@example.test"]) {
        assert.equal((await apply(running, reference, actor, { coverLetterText: `Letter from ${actor}` })).status, 201);
      }
      const before = new Map((await records(running, reference)).map((r) => [r.applicationId, r]));
      assert.equal(documentCount(databasePath), 3);

      const withdrawn = await request(running, `/api/adverts/${reference}/applications/mine`, {
        role: "candidate",
        actor: "withdraw@example.test",
        method: "DELETE"
      });
      assert.equal(withdrawn.status, 204);
      const erased = await request(running, `/api/requisitions/${reference}/applications/2/erase`, {
        role: "recruiter",
        method: "POST",
        body: { reason: "Candidate asked by email" }
      });
      assert.equal(erased.status, 204);
      assert.equal(documentCount(databasePath), 1);
      assert.equal(running.application.maintain(Date.now() + 31 * day).purged, 1);
      assert.equal(documentCount(databasePath), 0);

      for (const record of await records(running, reference)) {
        assert.equal(record.hasCvDocument, false);
        assert.equal(record.coverLetterText, null);
        assert.equal(record.cvText, "");
        assert.equal(record.total, before.get(record.applicationId)?.total);
        assert.deepEqual(record.breakdown, before.get(record.applicationId)?.breakdown);
        assert.equal(record.evidence.detail, before.get(record.applicationId)?.evidence.detail);
        assert.equal((await fetchCv(running, reference, record.applicationId)).status, 404);
      }
    },
    { retentionDays: 30 }
  );
});

test("the database refuses to change a cover letter or delete a linked CV outside erasure", async () => {
  await withApplication("pdf-triggers", async (running, databasePath) => {
    const reference = await advert(running);
    assert.equal((await apply(running, reference, "ada@example.test", { coverLetterText: "Hello" })).status, 201);
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("PRAGMA foreign_keys = ON");
      assert.throws(
        () => database.prepare("UPDATE applications SET cover_letter_text = 'Edited'").run(),
        /application-immutable/u
      );
      assert.throws(() => database.prepare("UPDATE applications SET cv_document_id = NULL").run(), /application-immutable/u);
      assert.throws(() => database.prepare("UPDATE documents SET bytes = x'00'").run(), /document-immutable/u);
      assert.throws(() => database.prepare("DELETE FROM documents").run(), /FOREIGN KEY constraint failed/u);
    } finally {
      database.close();
    }
  });
});

const boundary = "kodamai-test-boundary";

function part(name: string, filename: string | null, content: string | Buffer): Buffer {
  const disposition = `form-data; name="${name}"${filename === null ? "" : `; filename="${filename}"`}`;
  const type = filename === null ? "" : "Content-Type: application/pdf\r\n";
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n${type}\r\n`),
    Buffer.isBuffer(content) ? content : Buffer.from(content),
    Buffer.from("\r\n")
  ]);
}

/** Send a raw multipart body, which may stop mid-part, and read the reply. */
function rawUpload(origin: string, body: Buffer): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      `${origin}/api/adverts/1/applications`,
      {
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": String(body.length),
          "x-demo-role": "candidate",
          "x-demo-actor": "malformed@example.test",
          "x-demo-tenant": "demo",
          "idempotency-key": randomUUID()
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) })
        );
      }
    );
    // The server may answer before the whole body is sent; that is expected.
    outgoing.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ECONNRESET") reject(error);
    });
    outgoing.end(body);
  });
}

/** Start sending an upload, then drop the connection part-way through. */
function abandonUpload(origin: string): Promise<void> {
  return new Promise((resolve) => {
    const outgoing = httpRequest(`${origin}/api/adverts/1/applications`, {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": "100000",
        "x-demo-role": "candidate",
        "x-demo-actor": "abandoned@example.test",
        "x-demo-tenant": "demo",
        "idempotency-key": randomUUID()
      }
    });
    outgoing.on("error", () => undefined);
    outgoing.write(part("cv", "cv.pdf", "%PDF-1.7 partial"));
    setTimeout(() => {
      outgoing.destroy();
      resolve();
    }, 50);
  });
}

test("malformed and abandoned uploads are refused without stopping the server", { timeout: 30_000 }, async () => {
  await withApplication("malformed-upload", async (running, databasePath) => {
    const reference = await advert(running);
    assert.equal(reference, 1);
    const truncatedCv = part("cv", "cv.pdf", "%PDF-1.7 truncated").subarray(0, -2);
    const cases: Array<[string, Buffer, number, string]> = [
      ["a CV part with no closing boundary", truncatedCv, 400, "invalid-multipart"],
      [
        "a second CV cut short",
        Buffer.concat([part("cv", "one.pdf", pdf(["One"])), truncatedCv]),
        400,
        "too-many-cvs"
      ],
      ["an unexpected file cut short", part("photo", "photo.pdf", "%PDF-1.7 cut").subarray(0, -2), 400, "unexpected-file"],
      [
        "an oversized CV cut short",
        part("cv", "big.pdf", Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(5 * 1024 * 1024 + 10)])).subarray(0, -2),
        413,
        "cv-too-large"
      ]
    ];
    for (const [label, body, status, error] of cases) {
      const refused = await rawUpload(running.origin, body);
      assert.equal(refused.status, status, label);
      assert.deepEqual(refused.json, { error }, label);
    }
    await abandonUpload(running.origin);
    const repeated = await Promise.all(Array.from({ length: 20 }, () => rawUpload(running.origin, truncatedCv)));
    assert.ok(repeated.every(({ status }) => status === 400));

    const health = await fetch(`${running.origin}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(documentCount(databasePath), 0);
    // A good upload still works afterwards.
    assert.equal((await apply(running, reference, "after@example.test")).status, 201);
  });
});

test("a truncated upload does not end a separate server process", { timeout: 30_000 }, async () => {
  const server = fileURLToPath(new URL("./server.js", import.meta.url));
  const child = spawn(
    process.execPath,
    [
      "--no-warnings",
      "--input-type=module",
      "-e",
      `const { createApplication } = await import(${JSON.stringify(server)});
       const app = await createApplication({ databasePath: ":memory:", maintenanceIntervalMs: 0 });
       app.server.listen(0, "127.0.0.1", () => console.log(app.server.address().port));`
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  try {
    const port = await new Promise<number>((resolve, reject) => {
      child.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
      child.once("exit", (code) => reject(new Error(`server exited early (${code}): ${stderr}`)));
    });
    const origin = `http://127.0.0.1:${port}`;
    const refused = await rawUpload(origin, part("cv", "cv.pdf", "%PDF-1.7 truncated").subarray(0, -2));
    assert.equal(refused.status, 400);
    assert.equal((await fetch(`${origin}/api/health`)).status, 200);
    assert.equal(child.exitCode, null, stderr);
  } finally {
    child.kill();
  }
});
