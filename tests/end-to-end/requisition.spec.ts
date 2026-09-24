import { expect, test, type Page } from "@playwright/test";

async function viewAs(page: Page, role: "Requester" | "Approver"): Promise<void> {
  await page.getByLabel("Demo role").waitFor();
  await page.getByLabel("Demo role").getByRole("button", { name: role }).click();
}

async function fillFields(
  page: Page,
  fields: { role?: string; department?: string; headcount?: string; budget?: string; justification?: string }
): Promise<void> {
  if (fields.role !== undefined) await page.getByLabel("Role title").fill(fields.role);
  if (fields.department !== undefined) await page.getByLabel("Department").fill(fields.department);
  if (fields.headcount !== undefined) await page.getByLabel("Headcount").fill(fields.headcount);
  if (fields.budget !== undefined) await page.getByLabel("Annual budget (GBP)").fill(fields.budget);
  if (fields.justification !== undefined) {
    await page.getByLabel("Business justification").fill(fields.justification);
  }
}

test("requester and approver complete the rework-and-approval journey", async ({ page }) => {
  await page.goto("/");

  // Requester creates, edits and submits a draft.
  await viewAs(page, "Requester");
  await page.getByRole("button", { name: "New requisition" }).click();
  await fillFields(page, {
    role: "Platform Engineer",
    department: "Engineering",
    headcount: "1",
    budget: "85000",
    justification: "Own the typed workflow kernel."
  });
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("heading", { name: "Platform Engineer", level: 1 })).toBeVisible();
  await expect(page.locator(".status-badge")).toHaveText("Draft");

  await fillFields(page, { headcount: "2" });
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".facts")).toContainText("Headcount2");

  await page.getByRole("button", { name: "Submit requisition" }).click();
  await expect(page.locator(".status-badge")).toHaveText("Awaiting review");

  // The requester role has no review controls.
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);

  // Approver sees it in the inbox and requests changes; a reason is required.
  await viewAs(page, "Approver");
  const inbox = page.getByRole("navigation", { name: "Awaiting your review" });
  await expect(inbox.getByRole("button", { name: /Platform Engineer/ })).toBeVisible();
  await inbox.getByRole("button", { name: /Platform Engineer/ }).click();
  await page.getByRole("button", { name: "Request changes" }).click();
  await expect(page.getByRole("alert")).toContainText("Give a reason");
  await page.getByLabel("Reason for declining or requesting changes").fill("Justify the second hire.");
  await page.getByRole("button", { name: "Request changes" }).click();
  await expect(page.locator(".status-badge")).toHaveText("Changes requested");
  await expect(page.getByText("Nothing is waiting for your review.")).toBeVisible();

  // Requester revises and resubmits as revision 1.
  await viewAs(page, "Requester");
  await expect(page.getByRole("heading", { name: "Respond to requested changes" })).toBeVisible();
  await fillFields(page, { justification: "Two engineers: one for the kernel, one for the API." });
  await page.getByRole("button", { name: "Revise and resubmit" }).click();
  await expect(page.locator(".status-badge")).toHaveText("Awaiting review");
  await expect(page.locator(".facts")).toContainText("Revision1");

  // Approver approves the revision.
  await viewAs(page, "Approver");
  await page.getByRole("navigation", { name: "Awaiting your review" })
    .getByRole("button", { name: /Platform Engineer/ })
    .click();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.locator(".status-badge")).toHaveText("Approved");

  // Closing and reopening recovers the state and complete history.
  await page.reload();
  await viewAs(page, "Approver");
  await page.getByRole("button", { name: /Platform Engineer/ }).click();
  await expect(page.locator(".status-badge")).toHaveText("Approved");
  const timeline = page.locator(".timeline li strong");
  await expect(timeline).toHaveText([
    "approved",
    "submitted",
    "revised",
    "held",
    "submitted",
    "draft updated",
    "draft created"
  ]);
});

test("a declined requisition is terminal for both roles", async ({ page }) => {
  await page.goto("/");
  await viewAs(page, "Requester");
  await page.getByRole("button", { name: "New requisition" }).click();
  await fillFields(page, {
    role: "Office Manager",
    department: "Operations",
    headcount: "1",
    budget: "40000",
    justification: "Cover front-of-house."
  });
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByRole("button", { name: "Submit requisition" }).click();
  await expect(page.locator(".status-badge")).toHaveText("Awaiting review");

  await viewAs(page, "Approver");
  await page.getByRole("navigation", { name: "Awaiting your review" })
    .getByRole("button", { name: /Office Manager/ })
    .click();
  await page.getByLabel("Reason for declining or requesting changes").fill("No budget this quarter.");
  await page.getByRole("button", { name: "Decline" }).click();
  await expect(page.locator(".status-badge")).toHaveText("Declined");
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);

  await viewAs(page, "Requester");
  await page.getByRole("button", { name: /Office Manager/ }).click();
  await expect(page.locator(".status-badge")).toHaveText("Declined");
  await expect(page.getByRole("button", { name: "Revise and resubmit" })).toHaveCount(0);
  await expect(page.getByText("No budget this quarter.")).toBeVisible();
});
