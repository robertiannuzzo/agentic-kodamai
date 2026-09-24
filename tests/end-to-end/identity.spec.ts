import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";

async function api(request: APIRequestContext, role: string, actor: string, path: string, data: unknown) {
  const response = await request.post(path, {
    headers: {
      "x-demo-role": role,
      "x-demo-actor": actor,
      "x-demo-tenant": "demo",
      "idempotency-key": randomUUID()
    },
    data
  });
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return (await response.json()) as { reference: number; generation: number };
}

test("a slow response for a previous candidate never overwrites the current one", async ({ page, request }) => {
  // Seed an open role that one candidate has applied to and another has not.
  let row = await api(request, "requester", "requester@kodamai.test", "/api/requisitions", {
    fields: { role: "Race Condition Analyst", department: "QA", headcount: 1, budgetMinor: 5000000, justification: "Test stale responses." }
  });
  row = await api(request, "requester", "requester@kodamai.test", `/api/requisitions/${row.reference}/submit`, { generation: row.generation });
  row = await api(request, "approver", "approver@kodamai.test", `/api/requisitions/${row.reference}/review`, {
    generation: row.generation,
    decision: "approve",
    reason: ""
  });
  row = await api(request, "recruiter", "recruiter@kodamai.test", `/api/requisitions/${row.reference}/advert`, {
    generation: row.generation,
    questions: [{ prompt: "Ready?", expected: "yes" }],
    skills: [{ keyword: "testing", weight: 1, targetYears: 1 }]
  });
  await api(request, "candidate", "slow@example.test", `/api/adverts/${row.reference}/applications`, {
    candidateName: "Slow Candidate",
    cvText: "Testing",
    acknowledgedPrivacyNotice: true,
    answers: [{ questionId: 1, answer: "yes" }],
    years: [{ skillId: 1, years: 1 }]
  });

  // Delay only the candidate who has applied.
  await page.route("**/api/adverts", async (route) => {
    if (route.request().headers()["x-demo-actor"] === "slow@example.test") {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    await route.continue();
  });

  await page.goto("/");
  await page.getByLabel("Demo role").getByRole("button", { name: "Candidate", exact: true }).click();
  const email = page.getByLabel("Candidate email");
  await email.fill("slow@example.test");
  await email.press("Enter");
  await email.fill("fast@example.test");
  await email.press("Enter");

  await page.getByRole("navigation", { name: "Open roles" }).getByRole("button", { name: /Race Condition Analyst/ }).click();
  await expect(page.getByRole("button", { name: "Submit application" })).toBeVisible();
  await page.waitForTimeout(2000);
  // The slow candidate's "applied" state arrived late and must have been ignored.
  await expect(page.getByRole("button", { name: "Submit application" })).toBeVisible();
  await expect(page.getByText("Application received")).toHaveCount(0);
});
