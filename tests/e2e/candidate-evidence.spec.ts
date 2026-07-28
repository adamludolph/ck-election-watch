import { expect, test, type Page } from "@playwright/test";
import { monitorRuntime } from "./runtime-monitor";

const runtimeProblems = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  runtimeProblems.set(page, monitorRuntime(page));
});

test.afterEach(async ({ page }) => {
  expect(runtimeProblems.get(page)).toEqual([]);
});

test("home evidence-demo link opens the synthetic candidate record", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Open the evidence demo" }).click();
  await expect(page).toHaveURL(/\/candidates\/demo-candidate$/);
  await expect(page.getByRole("heading", { name: "Alex Morgan" })).toBeVisible();
});

test("publishes one traceable statement while keeping drafts and raw data private", async ({
  page,
}) => {
  await page.goto("/candidates/demo-candidate");
  await expect(page.getByRole("heading", { name: "Alex Morgan" })).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name:
      "Establish a municipal physician recruitment office and publish annual vacancy targets.",
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "No explicit public statement found in the sources reviewed.",
    ),
  ).toHaveCount(2);
  await expect(
    page.getByText(/ward-by-ward resurfacing schedule/),
  ).toHaveCount(0);
  await page.getByText("Inspect the evidence trace").click();
  await expect(page.getByText("Snapshot SHA-256")).toBeVisible();
  for (const link of await page.locator(
    ".source-list a, .evidence-grid a",
  ).all()) {
    const box = await link.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  await expect(
    page.getByText("block_64211ef5f1ab_1_7390f3930269"),
  ).toBeVisible();
  await expect(page.getByText(/window\.tracking/)).toHaveCount(0);
  await expect(page.getByText(/officialImportRunId/)).toHaveCount(0);
  await expect(page.getByText(/candidate-page-self-identification/)).toHaveCount(
    0,
  );
});

test("unknown candidacy renders a 404", async ({ page }) => {
  const response = await page.goto("/candidates/not-a-candidate");
  expect(response?.status()).toBe(404);
  await expect(page.getByText("That candidacy is not in this evidence record."))
    .toBeVisible();
  const problems = runtimeProblems.get(page) ?? [];
  expect(problems).toEqual([
    "console:error:Failed to load resource: the server responded with a status of 404 (Not Found)",
  ]);
  problems.length = 0;
});
