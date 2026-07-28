import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalReviewDisabledError } from "@/lib/core/errors";
import { createMemoryDatabase } from "@/lib/db/client";
import { handleReviewAction } from "@/lib/editorial/action-handler";
import { prepareDemoDatabase } from "@/lib/pipeline/prepare-demo";

describe("review action boundary", () => {
  let db: PGlite;
  let roadsId: string;

  beforeEach(async () => {
    db = await createMemoryDatabase();
    roadsId = (await prepareDemoDatabase(db)).statementIds["statement-roads"];
  });

  afterEach(async () => {
    await db.close();
  });

  it("fails closed in production before acquiring a database", async () => {
    const getDatabase = vi.fn();
    await expect(
      handleReviewAction(new FormData(), {
        nodeEnv: "production",
        getDatabase,
      }),
    ).rejects.toThrow(LocalReviewDisabledError);
    expect(getDatabase).not.toHaveBeenCalled();
  });

  it("records a validated local action and returns the next phase", async () => {
    const formData = new FormData();
    formData.set("action", "reviewed_ready");
    formData.set("statementId", roadsId);
    formData.set("requestId", "test:action-handler:review");
    formData.set("operatorRef", "forged:browser-operator");
    formData.set("expectedPhase", "needs_review");
    formData.set("candidacySlug", "demo-candidate");
    formData.set("note", "Private fixture note.");

    await expect(
      handleReviewAction(formData, {
        nodeEnv: "test",
        getDatabase: async () => db,
        clock: () => "2026-07-24T18:00:00.000Z",
      }),
    ).resolves.toEqual({
      status: "success",
      message:
        "Recorded reviewed ready. Current state: ready to approve.",
      phase: "ready_to_approve",
      candidacySlug: "demo-candidate",
    });
    const event = await db.query<{ operator_ref: string }>(
      "SELECT operator_ref FROM statement_editorial_events WHERE request_id = $1",
      ["test:action-handler:review"],
    );
    expect(event.rows[0].operator_ref).toBe("fixture:local-operator");
  });

  it("returns expected editorial errors but rethrows unexpected failures", async () => {
    await expect(
      handleReviewAction(new FormData(), {
        nodeEnv: "test",
        getDatabase: async () => db,
      }),
    ).resolves.toMatchObject({
      status: "error",
      message: expect.stringContaining("Invalid option"),
    });

    const failure = new Error("database unavailable");
    await expect(
      handleReviewAction(new FormData(), {
        nodeEnv: "test",
        getDatabase: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });

  it("identifies the invalid form field without trusting browser validation", async () => {
    const formData = new FormData();
    formData.set("action", "approved");
    formData.set("statementId", roadsId);
    formData.set("requestId", "test:action-handler:missing-reason");
    formData.set("expectedPhase", "ready_to_approve");
    formData.set("reason", "");

    await expect(
      handleReviewAction(formData, {
        nodeEnv: "test",
        getDatabase: async () => db,
      }),
    ).resolves.toEqual({
      status: "error",
      message: "A reason is required for this action.",
      field: "reason",
    });
  });
});
