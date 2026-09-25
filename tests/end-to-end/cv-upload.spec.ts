import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { pdf } from "../fixtures/pdf";

async function api(request: APIRequestContext, role: string, path: string, data: unknown) {
  const response = await request.post(path, {
    headers: {
      "x-demo-role": role,
      "x-demo-actor": `${role}@kodamai.test`,
      "x-demo-tenant": "demo",
      "idempotency-key": randomUUID()
    },
    data
  });
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return (await response.json()) as { reference: number; generation: number };
}

test("a candidate is told plainly when their CV or cover letter cannot be accepted", async ({ page, request }) => {
  let row = await api(request, "requester", "/api/requisitions", {
    fields: { role: "Upload Checker", department: "QA", headcount: 1, budgetMinor: 5000000, justification: "Test CV uploads." }
  });
  row = await api(request, "requester", `/api/requisitions/${row.reference}/submit`, { generation: row.generation });
  row = await api(request, "approver", `/api/requisitions/${row.reference}/review`, {
    generation: row.generation,
    decision: "approve",
    reason: ""
  });
  await api(request, "recruiter", `/api/requisitions/${row.reference}/advert`, {
    generation: row.generation,
    questions: [{ prompt: "Ready?", expected: "yes" }],
    skills: [{ keyword: "testing", weight: 1, targetYears: 1 }]
  });

  await page.goto("/");
  await page.getByLabel("Demo role").getByRole("button", { name: "Candidate", exact: true }).click();
  const email = page.getByLabel("Candidate email");
  await email.fill("uploader@example.test");
  await email.press("Enter");
  await page.getByRole("navigation", { name: "Open roles" }).getByRole("button", { name: /Upload Checker/ }).click();
  await expect(page.getByText("PDF only, 5 MB maximum.")).toBeVisible();

  const cv = page.getByLabel("CV (PDF)");
  await cv.setInputFiles({ name: "cv.docx", mimeType: "application/msword", buffer: Buffer.from("Not a PDF") });
  await expect(page.getByRole("alert")).toHaveText("Upload your CV as a PDF.");

  const large = Buffer.concat([pdf(["Big"]), Buffer.alloc(5 * 1024 * 1024)]);
  await cv.setInputFiles({ name: "large.pdf", mimeType: "application/pdf", buffer: large });
  await expect(page.getByRole("alert")).toHaveText("Your CV must be 5 MB or smaller.");
  await expect(page.getByText("5.0 MB")).toBeVisible();

  // Choosing an acceptable file clears the message.
  await cv.setInputFiles({ name: "scanned.pdf", mimeType: "application/pdf", buffer: pdf([]) });
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.getByLabel("First name").fill("Una");
  await page.getByLabel("Last name").fill("Loader");
  await page.getByLabel("Ready?").fill("yes");
  await page.getByLabel("testing", { exact: true }).fill("1");
  await page.getByLabel("I have read how my application will be used.").check();

  // The server reads the file and finds no text in it.
  await page.getByRole("button", { name: "Submit application" }).click();
  await expect(page.getByRole("alert")).toHaveText("We couldn’t read text from this PDF. Please upload a text-based PDF.");

  const coverLetter = page.getByLabel("Cover letter (optional)");
  await coverLetter.fill("a".repeat(5001));
  await expect(page.getByText("5,001 / 5,000")).toBeVisible();
  await cv.setInputFiles({ name: "cv.pdf", mimeType: "application/pdf", buffer: pdf(["Testing for five years"]) });
  await page.getByRole("button", { name: "Submit application" }).click();
  await expect(page.getByRole("alert")).toHaveText("Keep your cover letter to 5,000 characters or fewer.");

  await coverLetter.fill("I enjoy finding problems before customers do.");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Submit application" }).click();
  await expect(page.getByRole("status")).toContainText("Application received");
});
