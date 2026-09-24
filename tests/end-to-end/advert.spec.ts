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
  await page.getByLabel("I have read how my application will be used.").check();
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
  await expect(page.getByTestId("stage")).toHaveText("Awaiting review");
  await viewAs(page, "Approver");
  await page.getByRole("navigation", { name: "Awaiting your review" })
    .getByRole("button", { name: /Compiler Engineer/ })
    .click();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByTestId("stage")).toHaveText("Approved");

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
  await expect(page.getByTestId("stage")).toHaveText("Advertising");
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
  const applications = page.getByRole("list", { name: "Applications" }).getByRole("listitem", { name: /^Application \d+$/ });
  await expect(applications).toHaveCount(2);
  await expect(applications.nth(0)).toContainText("Ada Lovelace");
  await expect(applications.nth(0).getByTestId("total")).toHaveText("46 / 49");
  await expect(applications.nth(1)).toContainText("Grace Hopper");
  await expect(applications.nth(1).getByTestId("total")).toHaveText("20 / 49");
  await applications.nth(0).getByText("Ada Lovelace").click();
  await expect(applications.nth(0)).toContainText("keywords5");
  await expect(applications.nth(0)).toContainText("experience18");
  await expect(applications.nth(0)).toContainText("policy:recruitment-score-v1");
  await expect(page.getByText("They are not a hiring decision", { exact: false })).toBeVisible();

  // A person decides: shortlist Ada; rejecting Grace needs a reason.
  await applications.nth(0).getByLabel("Private note").fill("Strong compiler background.");
  await applications.nth(0).getByRole("button", { name: "Shortlist" }).click();
  await expect(applications.nth(0).getByTestId("decision")).toHaveText("Shortlisted");
  await expect(applications.nth(0)).toContainText("application:1;total:46;disposition:shortlist");
  await applications.nth(1).getByText("Grace Hopper").click();
  await applications.nth(1).getByRole("button", { name: "Reject" }).click();
  await expect(applications.nth(1).getByRole("alert")).toContainText("Give a reason");
  await applications.nth(1).getByLabel("Reason (required to reject)").fill("Needs more typed programming.");
  await applications.nth(1).getByRole("button", { name: "Reject" }).click();
  await expect(applications.nth(1).getByTestId("decision")).toHaveText("Rejected");

  // Grace withdraws; her personal data is erased but the decision record remains.
  await viewAs(page, "Candidate");
  const candidate = page.getByLabel("Candidate email");
  await candidate.fill("grace@example.test");
  await candidate.press("Enter");
  await page.getByRole("button", { name: "Withdraw and erase my application" }).click();
  await page.getByRole("button", { name: "Confirm withdrawal" }).click();
  await expect(page.getByRole("button", { name: "Submit application" })).toBeVisible();
  await expect(page.getByText("We keep your application for 180 days")).toBeVisible();

  await viewAs(page, "Recruiter");
  await page.getByRole("button", { name: /Compiler Engineer/ }).click();
  await expect(applications.nth(1)).toContainText("Erased candidate");
  await expect(applications.nth(1).getByTestId("decision")).toHaveText("Erased");
  await expect(applications.nth(1).getByTestId("total")).toHaveText("20 / 49");

  // Hire the shortlisted candidate: a people record with provenance, and the requisition fills.
  await applications.nth(0).getByText("Ada Lovelace").click();
  await applications.nth(0).getByLabel("Start date").fill("2026-11-02");
  await applications.nth(0).getByRole("button", { name: "Hire" }).click();
  await expect(applications.nth(0).getByTestId("decision")).toHaveText("Hired · EMP-0001");
  await expect(page.getByTestId("stage")).toHaveText("Filled");
  const provenance = page.getByRole("list", { name: "Provenance of Ada Lovelace" });
  await expect(provenance).toContainText("Scored 46 under recruitment-score-v1");
  await expect(provenance).toContainText("disposition:shortlist");
  await expect(provenance).toContainText("application:1");

  // A new candidate no longer sees the filled role.
  await viewAs(page, "Candidate");
  const newcomer = page.getByLabel("Candidate email");
  await newcomer.fill("late@example.test");
  await newcomer.press("Enter");
  await expect(page.getByRole("navigation", { name: "Open roles" }).getByRole("button")).toHaveCount(0);
  await viewAs(page, "Recruiter");

  // Reload: advert, applications and history come back.
  await page.reload();
  await viewAs(page, "Recruiter");
  await page.getByRole("button", { name: /Compiler Engineer/ }).click();
  await expect(page.getByRole("list", { name: "Applications" }).getByRole("listitem", { name: /^Application \d+$/ })).toHaveCount(2);
  await expect(page.getByRole("list", { name: "Audit timeline" }).getByTestId("event").first()).toHaveText("advert created");
});
