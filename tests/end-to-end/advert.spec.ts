import { expect, test, type Page } from "@playwright/test";

type Role = "Requester" | "Approver" | "Recruiter" | "Candidate";

async function viewAs(page: Page, role: Role): Promise<void> {
  await page.getByLabel("Demo role").getByRole("button", { name: role, exact: true }).click();
}

async function applyAs(
  page: Page,
  email: string,
  details: { name: string; answers: [string, string]; years: [string, string]; cv: string }
): Promise<void> {
  await viewAs(page, "Candidate");
  const identity = page.getByLabel("Candidate email");
  await identity.fill(email);
  await identity.press("Enter");
  await page.getByRole("navigation", { name: "Open roles" }).getByRole("button", { name: /Compiler Engineer/ }).click();
  await page.getByLabel("Full name").fill(details.name);
  await page.getByLabel("Can you work in the UK time zone?").fill(details.answers[0]);
  await page.getByLabel("Do you use typed programming?").fill(details.answers[1]);
  await page.getByLabel("idris", { exact: true }).fill(details.years[0]);
  await page.getByLabel("sql", { exact: true }).fill(details.years[1]);
  await page.getByLabel("CV").fill(details.cv);
  await page.getByLabel(/I consent/).check();
  await page.getByRole("button", { name: "Submit application" }).click();
  await expect(page.getByRole("status")).toContainText("Application received");
}

test("an approved requisition is advertised, applied to and reviewed with score workings", async ({ page }) => {
  await page.goto("/");

  // Requester raises, approver approves.
  await viewAs(page, "Requester");
  await page.getByRole("button", { name: "New requisition" }).click();
  await page.getByLabel("Role title").fill("Compiler Engineer");
  await page.getByLabel("Department").fill("Engineering");
  await page.getByLabel("Headcount").fill("1");
  await page.getByLabel("Annual budget (GBP)").fill("90000");
  await page.getByLabel("Business justification").fill("Grow the typed kernel team.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByRole("button", { name: "Submit requisition" }).click();
  await expect(page.locator(".status-badge")).toHaveText("Awaiting review");
  await viewAs(page, "Approver");
  await page.getByRole("navigation", { name: "Awaiting your review" })
    .getByRole("button", { name: /Compiler Engineer/ })
    .click();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.locator(".status-badge")).toHaveText("Approved");

  // Recruiter picks it from the queue and publishes the advert.
  await viewAs(page, "Recruiter");
  await page.getByRole("navigation", { name: "Ready to advertise" })
    .getByRole("button", { name: /Compiler Engineer/ })
    .click();
  await page.getByLabel("Question 1", { exact: true }).fill("Can you work in the UK time zone?");
  await page.getByLabel("Expected answer", { exact: true }).fill("yes");
  await page.getByRole("button", { name: "Add question" }).click();
  await page.getByLabel("Question 2", { exact: true }).fill("Do you use typed programming?");
  await page.getByLabel("Expected answer", { exact: true }).nth(1).fill("yes");
  await page.getByLabel("Skill 1 keyword", { exact: true }).fill("idris");
  await page.getByLabel("Weight", { exact: true }).fill("3");
  await page.getByLabel("Target years", { exact: true }).fill("5");
  await page.getByRole("button", { name: "Add skill" }).click();
  await page.getByLabel("Skill 2 keyword", { exact: true }).fill("sql");
  await page.getByLabel("Weight", { exact: true }).nth(1).fill("2");
  await page.getByLabel("Target years", { exact: true }).nth(1).fill("3");
  await page.getByRole("button", { name: "Publish advert" }).click();
  await expect(page.locator(".status-badge")).toHaveText("Advertising");
  await expect(page.getByText("Frozen", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish advert" })).toHaveCount(0);

  // Two candidates apply; the candidate view never shows expected answers or weights.
  await applyAs(page, "ada@example.test", {
    name: "Ada Lovelace",
    answers: ["yes", "yes"],
    years: ["4", "8"],
    cv: "Idris and SQL experience building compilers."
  });
  await expect(page.getByText("weight", { exact: false })).toHaveCount(0);
  await applyAs(page, "grace@example.test", {
    name: "Grace Hopper",
    answers: ["Yes ", "no"],
    years: ["1", "2"],
    cv: "COBOL and Haskell."
  });

  // Ada sees her application as received on return; she cannot apply twice.
  const identity = page.getByLabel("Candidate email");
  await identity.fill("ada@example.test");
  await identity.press("Enter");
  await expect(page.getByRole("status")).toContainText("Application received");
  await expect(page.getByRole("button", { name: "Submit application" })).toHaveCount(0);

  // Recruiter reviews ranked applications and their workings.
  await viewAs(page, "Recruiter");
  await page.getByRole("button", { name: /Compiler Engineer/ }).click();
  const applications = page.locator(".application-list > li");
  await expect(applications).toHaveCount(2);
  await expect(applications.nth(0)).toContainText("Ada Lovelace");
  await expect(applications.nth(0).locator(".total")).toHaveText("46 / 49");
  await expect(applications.nth(1)).toContainText("Grace Hopper");
  await expect(applications.nth(1).locator(".total")).toHaveText("20 / 49");
  await applications.nth(0).locator("summary").click();
  await expect(applications.nth(0).locator(".breakdown")).toContainText("keywords5");
  await expect(applications.nth(0).locator(".breakdown")).toContainText("experience18");
  await expect(applications.nth(0)).toContainText("policy:recruitment-score-v1");
  await expect(page.getByText("They are not a hiring decision.")).toBeVisible();

  // Reload: advert, applications and history come back.
  await page.reload();
  await viewAs(page, "Recruiter");
  await page.getByRole("button", { name: /Compiler Engineer/ }).click();
  await expect(page.locator(".application-list > li")).toHaveCount(2);
  await expect(page.locator(".timeline li strong").first()).toHaveText("advert created");
});
