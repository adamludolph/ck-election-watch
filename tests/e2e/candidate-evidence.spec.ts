import { expect, test } from "@playwright/test";

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
    page.getByText("No reviewed statement is currently available."),
  ).toBeVisible();
  await expect(
    page.getByText(
      "No explicit public statement found in the sources reviewed.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText(/ward-by-ward resurfacing schedule/),
  ).toHaveCount(0);
  await page.getByText("Inspect the evidence trace").click();
  await expect(page.getByText("Snapshot SHA-256")).toBeVisible();
  await expect(
    page.getByText("block_58af383dd5d4_1_7390f3930269"),
  ).toBeVisible();
  await expect(page.getByText(/window\.tracking/)).toHaveCount(0);
});

test("unknown candidacy renders a 404", async ({ page }) => {
  const response = await page.goto("/candidates/not-a-candidate");
  expect(response?.status()).toBe(404);
  await expect(page.getByText("That candidacy is not in this evidence record."))
    .toBeVisible();
});
