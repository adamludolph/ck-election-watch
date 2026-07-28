import { expect, test, type Page } from "@playwright/test";
import { monitorRuntime } from "./runtime-monitor";

const runtimeProblems = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  runtimeProblems.set(page, monitorRuntime(page));
});

test.afterEach(async ({ page }) => {
  expect(runtimeProblems.get(page)).toEqual([]);
});

test.describe.serial("local editorial review", () => {
  test("queue is inspect-only with all eight counted filters and accessible reflow", async ({
    page,
  }) => {
    await page.goto("/review");
    await expect(
      page.getByRole("heading", { name: "Editorial review" }),
    ).toBeVisible();
    const filters = [
      "All",
      "Needs review",
      "Changes requested",
      "Ready to approve",
      "Approved unpublished",
      "Published",
      "Rejected",
      "Withdrawn",
    ];
    for (const filter of filters) {
      await expect(
        page.getByRole("link", { name: new RegExp(`${filter} \\d+$`) }),
      ).toBeVisible();
    }
    await expect(
      page.getByRole("link", {
        name: /Prioritize preventive road maintenance.*Inspect evidence/s,
      }),
    ).toBeVisible();
    await expect(page.locator("#main-content").getByRole("button")).toHaveCount(0);

    await page.setViewportSize({ width: 320, height: 800 });
    await expect(page.getByRole("navigation", { name: "Editorial states" }))
      .toBeVisible();
    const overflow = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth - window.innerWidth,
      filters: (() => {
        const element = document.querySelector(".review-filters");
        return element ? element.scrollWidth - element.clientWidth : -1;
      })(),
    }));
    expect(overflow.page).toBeLessThanOrEqual(0);
    expect(overflow.filters).toBeLessThanOrEqual(0);
    for (const filter of filters) {
      await expect(
        page.getByRole("link", { name: new RegExp(`${filter} \\d+$`) }),
      ).toBeVisible();
    }

    await page.keyboard.press("Home");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" }))
      .toBeFocused();
    await page.getByRole("link", { name: "Skip to main content" }).click();
    await expect(page.locator("#main-content")).toBeFocused();
  });

  test("completes review through unpublication with focus-safe confirmation", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/review");
    await page
      .getByRole("link", {
        name: /Prioritize preventive road maintenance.*Inspect evidence/s,
      })
      .click();
    const currentPhase = page.locator(".review-orientation .review-phase");
    await expect(currentPhase).toHaveText("Needs review");
    await expect(
      page.getByRole("heading", { name: "Normalized public claim" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Exact supporting quote" }),
    ).toBeVisible();
    await expect(page.getByText("3 Extraction")).toBeVisible();
    await expect(page.getByText("4 Normalized content")).toBeVisible();
    await expect(page.getByText("5 Source snapshot")).toBeVisible();
    await expect(page.locator("details")).toHaveCount(3);
    for (const details of await page.locator("details").all()) {
      await expect(details).not.toHaveAttribute("open", "");
    }
    const sourceSnapshot = page.locator(".review-trace-details").last();
    await sourceSnapshot.locator("summary").click();
    for (const link of await sourceSnapshot.locator(
      ".review-details-body a",
    ).all()) {
      const box = await link.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    await sourceSnapshot.locator("summary").click();

    const stalePage = await page.context().newPage();
    const staleRuntimeProblems = monitorRuntime(stalePage);
    await stalePage.goto(page.url());
    const readyButton = page.getByRole("button", {
      name: "Mark ready to approve",
    });
    const staleReadyButton = stalePage.getByRole("button", {
      name: "Mark ready to approve",
    });
    const readyRequestId = await readyButton
      .locator("xpath=ancestor::form")
      .locator('input[name="requestId"]')
      .inputValue();
    const staleRequestId = await staleReadyButton
      .locator("xpath=ancestor::form")
      .locator('input[name="requestId"]')
      .inputValue();
    expect(staleRequestId).not.toBe(readyRequestId);

    await page.getByLabel("Private review note (optional)").fill(
      "PRIVATE_E2E_LIFECYCLE_REVIEW",
    );
    await readyButton.dblclick();
    await expect(currentPhase).toHaveText("Ready to approve");
    await expect(page.locator(".review-history li")).toHaveCount(1);

    await stalePage.getByLabel("Private review note (optional)").fill(
      "PRIVATE_E2E_STALE_TAB_REVIEW",
    );
    await staleReadyButton.click();
    const staleAlert = stalePage.locator(
      '.review-message-error[role="alert"]',
    );
    await expect(staleAlert).toBeFocused();
    await expect(staleAlert).toContainText(
      "Action reviewed_ready requires needs_review; current phase is ready_to_approve.",
    );
    await expect(
      staleAlert.getByRole("link", { name: "Reload current state" }),
    ).toBeVisible();
    await page.reload();
    await expect(currentPhase).toHaveText("Ready to approve");
    await expect(page.locator(".review-history li")).toHaveCount(1);
    expect(staleRuntimeProblems).toEqual([]);
    await stalePage.close();

    await page.getByLabel("Private approval reason (required)").fill(
      "PRIVATE_E2E_LIFECYCLE_APPROVAL",
    );
    await page.getByRole("button", { name: "Approve statement" }).click();
    await expect(currentPhase).toHaveText("Approved unpublished");

    const publishButton = page.getByRole("button", {
      name: "Publish statement",
    });
    await publishButton.click();
    await expect(
      page.getByRole("heading", { name: "Confirm public change" }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(publishButton).toBeFocused();

    await publishButton.click();
    await expect(
      page.getByRole("heading", { name: "Confirm public change" }),
    ).toBeFocused();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(publishButton).toBeFocused();

    await publishButton.click();
    await expect(
      page.getByRole("heading", { name: "Confirm public change" }),
    ).toBeFocused();
    await page.getByLabel("Private publication note (optional)").fill(
      "PRIVATE_E2E_LIFECYCLE_PUBLICATION",
    );
    await page.getByRole("button", { name: "Confirm publish statement" })
      .click();
    const publicLink = page.getByRole("link", {
      name: "Verify the public candidate page",
    });
    await expect(page.getByRole("status")).toBeFocused();
    await expect(currentPhase).toHaveText("Published");
    await expect(
      page.getByRole("button", { name: "Unpublish statement" }),
    ).toBeVisible();
    await expect(page.getByText("Published statement", { exact: true }))
      .toBeVisible();
    await publicLink.click();
    await expect(page).toHaveURL(/\/candidates\/demo-candidate$/);
    await expect(
      page.getByRole("heading", {
        name: /Prioritize preventive road maintenance/,
      }),
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText("PRIVATE_E2E");
    await page.goBack();
    await expect(currentPhase).toHaveText("Published");

    await page.getByRole("button", { name: "Unpublish statement" }).click();
    await expect(
      page.getByRole("heading", { name: "Confirm public change" }),
    ).toBeFocused();
    await page.getByLabel("Private unpublication reason (required)").fill(
      "PRIVATE_E2E_LIFECYCLE_WITHDRAWAL",
    );
    await page.getByRole("button", { name: "Confirm unpublish statement" })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Current state: withdrawn",
    );
    await expect(currentPhase).toHaveText("Withdrawn");
    await expect(page.getByText("Terminal state")).toBeVisible();
    await expect(
      page.getByText(
        "Unpublished statement · Closed statement after unpublication",
        { exact: true },
      ),
    ).toBeVisible();
    await page.getByRole("link", {
      name: "Verify the public candidate page",
    }).click();
    await expect(
      page.getByRole("heading", {
        name: /Prioritize preventive road maintenance/,
      }),
    ).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("PRIVATE_E2E");
  });

  test("records changes requested and terminal rejection", async ({ page }) => {
    await page.goto("/review");
    await page
      .getByRole("link", {
        name: /Increase peak-hour bus frequency.*Inspect evidence/s,
      })
      .click();
    const currentPhase = page.locator(".review-orientation .review-phase");
    const changeReason = page.getByLabel("Private change reason (required)");
    const requestChanges = page.getByRole("button", {
      name: "Request changes",
    });

    await changeReason.evaluate((element) => {
      element.removeAttribute("required");
    });
    await requestChanges.click();
    const validationAlert = page.locator(
      '.review-message-error[role="alert"]',
    );
    await expect(validationAlert).toBeFocused();
    await expect(validationAlert).toContainText(
      "A reason is required for this action.",
    );
    await expect(changeReason).toHaveAttribute("aria-invalid", "true");
    await expect(changeReason).toHaveAttribute(
      "aria-describedby",
      /-hint .*?-error$/,
    );
    await expect(page.locator(".review-field-error")).toHaveText(
      "A reason is required for this action.",
    );
    await expect(currentPhase).toHaveText("Needs review");

    await changeReason.evaluate((element) => {
      element.removeAttribute("maxlength");
    });
    await changeReason.fill(`PRIVATE_E2E_${"X".repeat(489)}`);
    await requestChanges.click();
    await expect(validationAlert).toBeFocused();
    await expect(validationAlert).toContainText(
      "Enter 500 characters or fewer.",
    );
    await expect(page.locator(".review-field-error")).toHaveText(
      "Enter 500 characters or fewer.",
    );
    await expect(currentPhase).toHaveText("Needs review");

    await changeReason.fill(
      "PRIVATE_E2E_TRANSIT_CHANGES",
    );
    await requestChanges.click();
    await expect(currentPhase).toHaveText("Changes requested");
    await page.getByLabel("Private rejection reason (required)").fill(
      "PRIVATE_E2E_TRANSIT_REJECTION",
    );
    await page.getByRole("button", { name: "Reject statement" }).click();
    await expect(currentPhase).toHaveText("Rejected");
    await expect(page.getByText("Terminal state")).toBeVisible();
    await page.setViewportSize({ width: 320, height: 800 });
    const historyOverflow = await page.evaluate(() => {
      const history = document.querySelector(".review-history");
      return {
        document: document.documentElement.scrollWidth - window.innerWidth,
        history: history ? history.scrollWidth - history.clientWidth : -1,
      };
    });
    expect(historyOverflow.document).toBeLessThanOrEqual(0);
    expect(historyOverflow.history).toBeLessThanOrEqual(0);
    await page.getByRole("link", { name: "Editorial review" }).click();
    await page.getByRole("link", { name: /^Rejected 1$/ }).click();
    await expect(
      page.getByRole("link", {
        name: /Increase peak-hour bus frequency.*Inspect evidence/s,
      }),
    ).toBeVisible();
    await page.goto("/candidates/demo-candidate");
    await expect(page.locator("body")).not.toContainText("peak-hour bus");
    await expect(page.locator("body")).not.toContainText("PRIVATE_E2E");
  });

  test("unknown review statement renders not found", async ({ page }) => {
    const response = await page.goto(
      "/review/statements/unknown-fixture-statement",
    );
    expect(response?.status()).toBe(404);
    await expect(page).toHaveURL(/\/review\/statements\/unknown-fixture-statement$/);
    await expect(
      page.getByRole("heading", {
        name: "That candidacy is not in this evidence record.",
      }),
    ).toBeVisible();
    await expect(page.locator("body")).toContainText("404 · Record not found");
    const problems = runtimeProblems.get(page) ?? [];
    expect(problems).toEqual([
      "console:error:Failed to load resource: the server responded with a status of 404 (Not Found)",
    ]);
    problems.length = 0;
  });
});
