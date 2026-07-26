import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordMockExtraction } from "@/lib/ai/extract";
import {
  EvidenceMismatchError,
  ExtractionSchemaError,
  PublicationPolicyError,
  SourceCaptureValidationError,
} from "@/lib/core/errors";
import { createMemoryDatabase } from "@/lib/db/client";
import { captureWebsiteFixture } from "@/lib/ingest/capture";
import { prepareDemoDatabase } from "@/lib/pipeline/prepare-demo";
import { runStage } from "@/lib/pipeline/stage";
import { getPublicCandidateRecord } from "@/lib/publication/public";
import {
  approveAndPublishStatement,
  publishApprovedStatement,
} from "@/lib/publication/publish";
import { completeFixtureCoverage } from "@/lib/review/coverage";

let db: PGlite;

async function createAlternateCandidacy(
  database: PGlite,
  id: string,
): Promise<void> {
  await database.query(
    "INSERT INTO people (id, display_name) VALUES ($1, $2)",
    [`person_${id}`, `Alternate ${id}`],
  );
  await database.query(
    `INSERT INTO candidacies (
       id, election_id, office_id, person_id, slug, status
     )
     SELECT $1, election_id, office_id, $2, $3, 'registered'
       FROM candidacies
      LIMIT 1`,
    [id, `person_${id}`, `alternate-${id}`],
  );
}

beforeEach(async () => {
  db = await createMemoryDatabase();
});

afterEach(async () => {
  await db.close();
});

describe("fixture-backed evidence pipeline", () => {
  it("prepares idempotently and exposes only immutable approved evidence", async () => {
    await prepareDemoDatabase(db);
    await prepareDemoDatabase(db);
    const counts = await db.query<{
      candidacies: number;
      snapshots: number;
      statements: number;
      evidence: number;
      publications: number;
    }>(
      `SELECT
        (SELECT COUNT(*)::integer FROM candidacies) AS candidacies,
        (SELECT COUNT(*)::integer FROM source_snapshots) AS snapshots,
        (SELECT COUNT(*)::integer FROM statements) AS statements,
        (SELECT COUNT(*)::integer FROM evidence) AS evidence,
        (SELECT COUNT(*)::integer FROM publications) AS publications`,
    );
    expect(counts.rows[0]).toEqual({
      candidacies: 1,
      snapshots: 1,
      statements: 2,
      evidence: 2,
      publications: 1,
    });

    const candidate = await getPublicCandidateRecord(db, "demo-candidate");
    expect(candidate?.coverageComplete).toBe(true);
    expect(candidate?.issues.find((issue) => issue.slug === "healthcare"))
      .toMatchObject({ statements: [{ summary: expect.stringContaining("physician") }] });
    expect(
      candidate?.issues.find((issue) => issue.slug === "roads")
        ?.absenceMessage,
    ).toBe("No reviewed statement is currently available.");
    expect(
      candidate?.issues.find((issue) => issue.slug === "transit")
        ?.absenceMessage,
    ).toBe(
      "No explicit public statement found in the sources reviewed.",
    );

    await db.query(
      "UPDATE statements SET summary = 'Mutated draft table' WHERE status = 'approved'",
    );
    const afterMutation = await getPublicCandidateRecord(db, "demo-candidate");
    expect(
      afterMutation?.issues[0].statements[0].summary,
    ).not.toBe("Mutated draft table");
  });

  it("keeps drafts private and rejects publication without approval", async () => {
    const prepared = await prepareDemoDatabase(db);
    const roads = await db.query<{ id: string }>(
      `SELECT id FROM statements
        WHERE extraction_run_id = $1
          AND extraction_item_id = 'statement-roads'`,
      [prepared.extractionRunId],
    );
    await expect(
      publishApprovedStatement(
        db,
        roads.rows[0].id,
        "2026-07-24T16:15:00.000Z",
      ),
    ).rejects.toThrow(PublicationPolicyError);
    const publications = await db.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM publications",
    );
    expect(publications.rows[0].count).toBe(1);

    const healthcare = await db.query<{ id: string }>(
      `SELECT id FROM statements
        WHERE extraction_run_id = $1
          AND extraction_item_id = 'statement-healthcare'`,
      [prepared.extractionRunId],
    );
    await expect(
      publishApprovedStatement(
        db,
        healthcare.rows[0].id,
        "2026-07-24T16:16:00.000Z",
      ),
    ).resolves.toMatchObject({ publicationId: expect.any(String) });
    await expect(
      publishApprovedStatement(
        db,
        "missing-statement",
        "2026-07-24T16:17:00.000Z",
      ),
    ).rejects.toThrow(PublicationPolicyError);
  });

  it("rejects mismatched extraction evidence without downstream statements", async () => {
    const prepared = await prepareDemoDatabase(db);
    const fixture = JSON.parse(
      await readFile(
        path.join(process.cwd(), "tests/fixtures/extraction-result.v1.json"),
        "utf8",
      ),
    ) as {
      items: Array<Record<string, unknown>>;
      schemaVersion: string;
    };
    fixture.items[0] = { ...fixture.items[0], quote: "Not in the block" };
    const before = await db.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM statements",
    );
    await expect(
      recordMockExtraction(db, {
        candidacyId: prepared.candidacyId,
        snapshotId: prepared.snapshotId,
        prompt: "different prompt",
        rawResult: fixture,
        now: "2026-07-24T16:20:00.000Z",
      }),
    ).rejects.toThrow(EvidenceMismatchError);
    const after = await db.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM statements",
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);

    const unknownBlock = structuredClone(fixture);
    unknownBlock.items[0] = {
      ...unknownBlock.items[0],
      blockId: "block_missing",
      quote:
        "To help recruit and retain doctors, I will establish a municipal physician recruitment office and publish annual vacancy targets.",
    };
    await expect(
      recordMockExtraction(db, {
        candidacyId: prepared.candidacyId,
        snapshotId: prepared.snapshotId,
        prompt: "unknown block prompt",
        rawResult: unknownBlock,
        now: "2026-07-24T16:21:00.000Z",
      }),
    ).rejects.toThrow(EvidenceMismatchError);

    const unknownIssue = JSON.parse(
      await readFile(
        path.join(process.cwd(), "tests/fixtures/extraction-result.v1.json"),
        "utf8",
      ),
    ) as typeof fixture;
    unknownIssue.items[0] = {
      ...unknownIssue.items[0],
      issueSlugs: ["invented-issue"],
    };
    await expect(
      recordMockExtraction(db, {
        candidacyId: prepared.candidacyId,
        snapshotId: prepared.snapshotId,
        prompt: "unknown issue prompt",
        rawResult: unknownIssue,
        now: "2026-07-24T16:22:00.000Z",
      }),
    ).rejects.toThrow(ExtractionSchemaError);

    await expect(
      recordMockExtraction(db, {
        candidacyId: prepared.candidacyId,
        snapshotId: prepared.snapshotId,
        prompt: "invalid schema prompt",
        rawResult: { schemaVersion: "2" },
        now: "2026-07-24T16:23:00.000Z",
      }),
    ).rejects.toThrow(ExtractionSchemaError);

    const failedStages = await db.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
         FROM stage_runs
        WHERE stage = 'extract' AND status = 'failed'`,
    );
    expect(failedStages.rows[0].count).toBe(4);
  });

  it("rejects cross-candidacy evidence, coverage, and ineligible attribution", async () => {
    const prepared = await prepareDemoDatabase(db);
    await createAlternateCandidacy(db, "candidacy_other");
    const [fixtureText, prompt] = await Promise.all([
      readFile(
        path.join(process.cwd(), "tests/fixtures/extraction-result.v1.json"),
        "utf8",
      ),
      readFile(
        path.join(process.cwd(), "prompts/extract-statements.md"),
        "utf8",
      ),
    ]);
    const fixture = JSON.parse(fixtureText) as {
      items: Array<Record<string, unknown>>;
      schemaVersion: string;
    };

    await expect(
      recordMockExtraction(db, {
        candidacyId: "candidacy_other",
        snapshotId: prepared.snapshotId,
        prompt,
        rawResult: fixture,
        now: "2026-07-24T17:10:00.000Z",
      }),
    ).rejects.toThrow(EvidenceMismatchError);

    const source = await db.query<{ id: string }>(
      "SELECT id FROM sources LIMIT 1",
    );
    await expect(
      completeFixtureCoverage(db, {
        candidacyId: "candidacy_other",
        sourceId: source.rows[0].id,
        snapshotId: prepared.snapshotId,
        extractionRunId: prepared.extractionRunId,
        attemptedUrl: "https://example.invalid/demo-candidate/platform",
        startedAt: "2026-07-24T17:11:00.000Z",
        completedAt: "2026-07-24T17:12:00.000Z",
      }),
    ).rejects.toThrow(PublicationPolicyError);

    const campaignClaim = structuredClone(fixture);
    campaignClaim.items[0] = {
      ...campaignClaim.items[0],
      attributedTo: "campaign",
    };
    await expect(
      recordMockExtraction(db, {
        candidacyId: prepared.candidacyId,
        snapshotId: prepared.snapshotId,
        prompt,
        rawResult: campaignClaim,
        now: "2026-07-24T17:13:00.000Z",
      }),
    ).rejects.toThrow(ExtractionSchemaError);
  });

  it("revalidates immutable evidence before approval and publication", async () => {
    const prepared = await prepareDemoDatabase(db);
    const roads = await db.query<{ id: string }>(
      `SELECT id FROM statements
        WHERE extraction_run_id = $1
          AND extraction_item_id = 'statement-roads'`,
      [prepared.extractionRunId],
    );
    await db.query(
      "UPDATE evidence SET quote = 'Fabricated evidence' WHERE statement_id = $1",
      [roads.rows[0].id],
    );
    await expect(
      approveAndPublishStatement(
        db,
        roads.rows[0].id,
        "2026-07-24T17:20:00.000Z",
      ),
    ).rejects.toThrow(PublicationPolicyError);
    const status = await db.query<{ status: string }>(
      "SELECT status FROM statements WHERE id = $1",
      [roads.rows[0].id],
    );
    expect(status.rows[0].status).toBe("draft");
  });

  it("reconciles a pre-existing extraction identity only when raw output agrees", async () => {
    const prepared = await prepareDemoDatabase(db);
    const [fixtureText, prompt] = await Promise.all([
      readFile(
        path.join(process.cwd(), "tests/fixtures/extraction-result.v1.json"),
        "utf8",
      ),
      readFile(
        path.join(process.cwd(), "prompts/extract-statements.md"),
        "utf8",
      ),
    ]);
    const fixture = JSON.parse(fixtureText) as {
      items: Array<Record<string, unknown>>;
      schemaVersion: string;
    };
    await db.query("DELETE FROM stage_runs WHERE stage = 'extract'");

    await expect(
      recordMockExtraction(db, {
        candidacyId: prepared.candidacyId,
        snapshotId: prepared.snapshotId,
        prompt,
        rawResult: fixture,
        now: "2026-07-24T17:30:00.000Z",
      }),
    ).resolves.toMatchObject({
      extractionRunId: prepared.extractionRunId,
      statementIds: [expect.any(String), expect.any(String)],
      abstentionCount: 1,
    });

    const changedResult = structuredClone(fixture);
    changedResult.items[0] = {
      ...changedResult.items[0],
      summary: "A materially different generated summary.",
    };
    await expect(
      recordMockExtraction(db, {
        candidacyId: prepared.candidacyId,
        snapshotId: prepared.snapshotId,
        prompt,
        rawResult: changedResult,
        now: "2026-07-24T17:31:00.000Z",
      }),
    ).rejects.toThrow(ExtractionSchemaError);
  });

  it("deduplicates bytes while retaining a later capture observation", async () => {
    const prepared = await prepareDemoDatabase(db);
    const html = await readFile(
      path.join(process.cwd(), "tests/fixtures/candidate-site.html"),
    );
    await captureWebsiteFixture(db, {
      candidacyId: prepared.candidacyId,
      sourceTitle: "Alex Morgan for Mayor — Platform",
      canonicalUrl: "https://example.invalid/demo-candidate/platform",
      originalUrl: "https://example.invalid/demo-candidate/platform",
      capturedAt: "2026-07-25T16:05:00.000Z",
      bytes: html,
    });
    const counts = await db.query<{
      snapshots: number;
      observations: number;
    }>(
      `SELECT
        (SELECT COUNT(*)::integer FROM source_snapshots) AS snapshots,
        (SELECT COUNT(*)::integer FROM capture_observations) AS observations`,
    );
    expect(counts.rows[0]).toEqual({ snapshots: 1, observations: 2 });
  });

  it("rejects empty captures and records failed-then-successful stage attempts", async () => {
    await expect(
      captureWebsiteFixture(db, {
        candidacyId: "missing",
        sourceTitle: "Empty",
        canonicalUrl: "https://example.invalid",
        originalUrl: "https://example.invalid",
        capturedAt: "2026-07-24T16:00:00.000Z",
        bytes: new Uint8Array(),
      }),
    ).rejects.toThrow(SourceCaptureValidationError);
    await expect(
      captureWebsiteFixture(db, {
        candidacyId: "missing",
        sourceTitle: "Invalid",
        canonicalUrl: "not a url",
        originalUrl: "not a url",
        capturedAt: "2026-07-24T16:00:00.000Z",
        bytes: new TextEncoder().encode("content"),
      }),
    ).rejects.toThrow(SourceCaptureValidationError);

    await expect(
      runStage(
        db,
        {
          stage: "retry-test",
          idempotencyKey: "logical-operation",
          processorName: "test",
          processorVersion: "1",
          inputRefs: {},
          now: "2026-07-24T16:00:00.000Z",
        },
        async () => {
          throw new Error("first attempt");
        },
      ),
    ).rejects.toThrow("first attempt");
    await runStage(
      db,
      {
        stage: "retry-test",
        idempotencyKey: "logical-operation",
        processorName: "test",
        processorVersion: "1",
        inputRefs: {},
        now: "2026-07-24T16:01:00.000Z",
      },
      async () => ({ value: "ok" }),
    );
    const attempts = await db.query<{ status: string }>(
      `SELECT status FROM stage_runs
        WHERE stage = 'retry-test'
        ORDER BY attempt`,
    );
    expect(attempts.rows.map((row) => row.status)).toEqual([
      "failed",
      "succeeded",
    ]);
  });

  it("rejects inconsistent coverage provenance", async () => {
    const prepared = await prepareDemoDatabase(db);
    const source = await db.query<{ id: string }>(
      "SELECT id FROM sources LIMIT 1",
    );
    await expect(
      completeFixtureCoverage(db, {
        candidacyId: prepared.candidacyId,
        sourceId: source.rows[0].id,
        snapshotId: "missing-snapshot",
        extractionRunId: prepared.extractionRunId,
        attemptedUrl: "https://example.invalid/other",
        startedAt: "2026-07-24T17:00:00.000Z",
        completedAt: "2026-07-24T17:01:00.000Z",
      }),
    ).rejects.toThrow(PublicationPolicyError);

    await expect(
      completeFixtureCoverage(db, {
        candidacyId: prepared.candidacyId,
        sourceId: source.rows[0].id,
        snapshotId: prepared.snapshotId,
        extractionRunId: prepared.extractionRunId,
        attemptedUrl: "https://example.invalid/not-the-captured-source",
        startedAt: "2026-07-24T17:02:00.000Z",
        completedAt: "2026-07-24T17:03:00.000Z",
      }),
    ).rejects.toThrow(PublicationPolicyError);
  });
});
