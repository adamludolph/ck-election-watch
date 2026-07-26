import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { recordMockExtraction } from "@/lib/ai/extract";
import { captureWebsiteFixture } from "@/lib/ingest/capture";
import { importCandidateFixture } from "@/lib/ingest/candidates";
import { normalizeSnapshot } from "@/lib/ingest/normalize";
import { approveAndPublishStatement } from "@/lib/publication/publish";
import { completeFixtureCoverage } from "@/lib/review/coverage";

const fixturePath = (...parts: string[]) =>
  path.join(process.cwd(), "tests", "fixtures", ...parts);

export async function prepareDemoDatabase(db: PGlite): Promise<{
  candidacyId: string;
  snapshotId: string;
  extractionRunId: string;
  publicationId: string;
  researchRunId: string;
}> {
  const [candidateJson, htmlBytes, extractionJson, prompt] = await Promise.all([
    readFile(fixturePath("official-candidates.json"), "utf8"),
    readFile(fixturePath("candidate-site.html")),
    readFile(fixturePath("extraction-result.v1.json"), "utf8"),
    readFile(path.join(process.cwd(), "prompts", "extract-statements.md"), "utf8"),
  ]);
  const candidate = await importCandidateFixture(
    db,
    JSON.parse(candidateJson),
  );
  for (const issue of [
    { id: "issue_healthcare", slug: "healthcare", label: "Healthcare" },
    { id: "issue_roads", slug: "roads", label: "Roads" },
    { id: "issue_transit", slug: "transit", label: "Transit" },
  ]) {
    await db.query(
      `INSERT INTO issues (id, slug, label)
       VALUES ($1, $2, $3) ON CONFLICT (slug) DO NOTHING`,
      [issue.id, issue.slug, issue.label],
    );
  }
  const url = "https://example.invalid/demo-candidate/platform";
  const capture = await captureWebsiteFixture(db, {
    candidacyId: candidate.candidacyId,
    sourceTitle: "Alex Morgan for Mayor — Platform",
    canonicalUrl: url,
    originalUrl: url,
    capturedAt: "2026-07-24T16:05:00.000Z",
    bytes: htmlBytes,
  });
  await normalizeSnapshot(
    db,
    capture.snapshotId,
    "2026-07-24T16:06:00.000Z",
  );
  const extraction = await recordMockExtraction(db, {
    candidacyId: candidate.candidacyId,
    snapshotId: capture.snapshotId,
    prompt,
    rawResult: JSON.parse(extractionJson),
    now: "2026-07-24T16:07:00.000Z",
  });
  const healthcare = await db.query<{ id: string }>(
    `SELECT id FROM statements
      WHERE extraction_run_id = $1
        AND extraction_item_id = 'statement-healthcare'`,
    [extraction.extractionRunId],
  );
  if (!healthcare.rows[0]) {
    throw new Error("Healthcare statement was not created.");
  }
  const publication = await approveAndPublishStatement(
    db,
    healthcare.rows[0].id,
    "2026-07-24T16:10:00.000Z",
  );
  const coverage = await completeFixtureCoverage(db, {
    candidacyId: candidate.candidacyId,
    sourceId: capture.sourceId,
    snapshotId: capture.snapshotId,
    extractionRunId: extraction.extractionRunId,
    attemptedUrl: url,
    startedAt: "2026-07-24T16:04:00.000Z",
    completedAt: "2026-07-24T16:12:00.000Z",
  });
  return {
    candidacyId: candidate.candidacyId,
    snapshotId: capture.snapshotId,
    extractionRunId: extraction.extractionRunId,
    publicationId: publication.publicationId,
    researchRunId: coverage.researchRunId,
  };
}
