import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { recordMockExtraction } from "@/lib/ai/extract";
import {
  acceptDiscoveredSource,
  recordDiscoveryFixture,
} from "@/lib/discovery/sources";
import { captureWebsiteFixture } from "@/lib/ingest/capture";
import { importOfficialRosterFixture } from "@/lib/ingest/candidates";
import { normalizeSnapshot } from "@/lib/ingest/normalize";
import { performEditorialAction } from "@/lib/editorial/workflow";
import { completeFixtureCoverage } from "@/lib/review/coverage";

const fixturePath = (...parts: string[]) =>
  path.join(process.cwd(), "tests", "fixtures", ...parts);

type PreparedDemo = {
  candidacyId: string;
  snapshotId: string;
  extractionRunId: string;
  researchRunId: string;
  officialImportRunId: string;
  discoveryRunId: string;
  discoveredSourceId: string;
  sourceId: string;
  statementIds: Record<string, string>;
};

export function prepareDemoDatabase(
  db: PGlite,
  options: { seedEditorialWorkflow: false },
): Promise<PreparedDemo & { publicationId: null }>;
export function prepareDemoDatabase(
  db: PGlite,
  options?: { seedEditorialWorkflow?: true },
): Promise<PreparedDemo & { publicationId: string }>;
export async function prepareDemoDatabase(
  db: PGlite,
  options: { seedEditorialWorkflow?: boolean } = {},
): Promise<PreparedDemo & { publicationId: string | null }> {
  const [candidateBytes, discoveryBytes, htmlBytes, extractionJson, prompt] =
    await Promise.all([
      readFile(fixturePath("official-candidates.json")),
      readFile(fixturePath("discovered-sources.json")),
      readFile(fixturePath("candidate-site.html")),
      readFile(fixturePath("extraction-result.v1.json"), "utf8"),
      readFile(
        path.join(process.cwd(), "prompts", "extract-statements.md"),
        "utf8",
      ),
    ]);
  const officialImport = await importOfficialRosterFixture(db, candidateBytes);
  const candidacyId = officialImport.candidacyIds[0];
  if (!candidacyId) {
    throw new Error("Official fixture did not import a candidacy.");
  }
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
  const discovery = await recordDiscoveryFixture(db, discoveryBytes);
  const discoveredSourceId = discovery.discoveredSourceIds[0];
  if (!discoveredSourceId) {
    throw new Error("Discovery fixture did not record a source.");
  }
  const accepted = await acceptDiscoveredSource(
    db,
    discoveredSourceId,
    "2026-07-24T16:03:00.000Z",
    "Accepted synthetic candidate-owned website fixture.",
  );
  if (!accepted.sourceId) {
    throw new Error("Accepted discovery did not create a source.");
  }
  const url = "https://example.invalid/demo-candidate/platform";
  const capture = await captureWebsiteFixture(db, {
    sourceId: accepted.sourceId,
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
    candidacyId,
    snapshotId: capture.snapshotId,
    prompt,
    rawResult: JSON.parse(extractionJson),
    now: "2026-07-24T16:07:00.000Z",
  });
  const statements = await db.query<{
    id: string;
    extraction_item_id: string;
  }>(
    `SELECT id, extraction_item_id FROM statements
      WHERE extraction_run_id = $1`,
    [extraction.extractionRunId],
  );
  const statementIds = Object.fromEntries(
    statements.rows.map((statement) => [
      statement.extraction_item_id,
      statement.id,
    ]),
  );
  const healthcareId = statementIds["statement-healthcare"];
  const clinicReportId = statementIds["statement-clinic-reports"];
  const roadTrackerId = statementIds["statement-road-tracker"];
  if (!healthcareId || !clinicReportId || !roadTrackerId) {
    throw new Error("Editorial fixture statements were not created.");
  }
  let publication: { publicationId: string } | null = null;
  if (options.seedEditorialWorkflow !== false) {
    const act = (
      input: Parameters<typeof performEditorialAction>[1],
      now: string,
    ) => performEditorialAction(db, input, () => now);
    await act(
      {
        action: "reviewed_ready",
        statementId: healthcareId,
        requestId: "fixture:healthcare:reviewed-ready",
        operatorRef: "fixture:editor-one",
        expectedPhase: "needs_review",
        note: "PRIVATE_SENTINEL_HEALTHCARE_REVIEW",
      },
      "2026-07-24T16:08:00.000Z",
    );
    await act(
      {
        action: "approved",
        statementId: healthcareId,
        requestId: "fixture:healthcare:approved",
        operatorRef: "fixture:editor-one",
        expectedPhase: "ready_to_approve",
        reason: "PRIVATE_SENTINEL_HEALTHCARE_APPROVAL",
      },
      "2026-07-24T16:09:00.000Z",
    );
    publication = await act(
      {
        action: "published",
        statementId: healthcareId,
        requestId: "fixture:healthcare:published",
        operatorRef: "fixture:publisher-one",
        expectedPhase: "approved_unpublished",
        reason: "PRIVATE_SENTINEL_HEALTHCARE_PUBLICATION",
      },
      "2026-07-24T16:10:00.000Z",
    ).then((result) => {
      if (!result.publicationId) {
        throw new Error("Published fixture did not return a publication.");
      }
      return { publicationId: result.publicationId };
    });
    await act(
      {
        action: "reviewed_ready",
        statementId: clinicReportId,
        requestId: "fixture:clinic:reviewed-ready",
        operatorRef: "fixture:editor-two",
        expectedPhase: "needs_review",
        note: "PRIVATE_SENTINEL_CLINIC_REVIEW",
      },
      "2026-07-24T16:08:30.000Z",
    );
    await act(
      {
        action: "reviewed_ready",
        statementId: roadTrackerId,
        requestId: "fixture:tracker:reviewed-ready",
        operatorRef: "fixture:editor-two",
        expectedPhase: "needs_review",
        note: "PRIVATE_SENTINEL_TRACKER_REVIEW",
      },
      "2026-07-24T16:08:40.000Z",
    );
    await act(
      {
        action: "approved",
        statementId: roadTrackerId,
        requestId: "fixture:tracker:approved",
        operatorRef: "fixture:editor-two",
        expectedPhase: "ready_to_approve",
        reason: "PRIVATE_SENTINEL_TRACKER_APPROVAL",
      },
      "2026-07-24T16:09:40.000Z",
    );
  }
  const coverage = await completeFixtureCoverage(db, {
    candidacyId,
    sourceId: capture.sourceId,
    snapshotId: capture.snapshotId,
    extractionRunId: extraction.extractionRunId,
    attemptedUrl: url,
    startedAt: "2026-07-24T16:04:00.000Z",
    completedAt: "2026-07-24T16:12:00.000Z",
  });
  return {
    candidacyId,
    snapshotId: capture.snapshotId,
    extractionRunId: extraction.extractionRunId,
    publicationId: publication?.publicationId ?? null,
    researchRunId: coverage.researchRunId,
    officialImportRunId: officialImport.officialImportRunId,
    discoveryRunId: discovery.discoveryRunId,
    discoveredSourceId,
    sourceId: accepted.sourceId,
    statementIds,
  };
}
