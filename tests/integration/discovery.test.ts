import type { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DiscoverySourceConflictError,
  DiscoveryTransitionError,
  DiscoveryValidationError,
  SourceCaptureValidationError,
} from "@/lib/core/errors";
import { stableId } from "@/lib/core/hash";
import { createMemoryDatabase } from "@/lib/db/client";
import {
  acceptDiscoveredSource,
  recordDiscoveryFixture,
  rejectDiscoveredSource,
  type DiscoveryFixture,
} from "@/lib/discovery/sources";
import { importOfficialRosterFixture } from "@/lib/ingest/candidates";
import { captureWebsiteFixture } from "@/lib/ingest/capture";

let db: PGlite;

const fixture = (name: string) =>
  path.join(process.cwd(), "tests/fixtures", name);

async function setupOfficialImport(): Promise<void> {
  await importOfficialRosterFixture(
    db,
    await readFile(fixture("official-candidates.json")),
  );
}

async function readDiscovery(): Promise<DiscoveryFixture> {
  return JSON.parse(await readFile(fixture("discovered-sources.json"), "utf8"));
}

function encodeDiscovery(value: DiscoveryFixture): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

beforeEach(async () => {
  db = await createMemoryDatabase();
});

afterEach(async () => {
  await db.close();
});

describe("manual discovery admission", () => {
  it("records proposed evidence idempotently without creating a source", async () => {
    await setupOfficialImport();
    const bytes = await readFile(fixture("discovered-sources.json"));
    const first = await recordDiscoveryFixture(db, bytes);
    const second = await recordDiscoveryFixture(db, bytes);
    expect(second).toEqual(first);

    const result = await db.query<{
      runs: number;
      discovered: number;
      sources: number;
      status: string;
      evidence: string;
    }>(
      `SELECT
        (SELECT COUNT(*)::integer FROM discovery_runs) AS runs,
        (SELECT COUNT(*)::integer FROM discovered_sources) AS discovered,
        (SELECT COUNT(*)::integer FROM sources) AS sources,
        (SELECT status FROM discovered_sources LIMIT 1) AS status,
        (SELECT ownership_evidence::text
           FROM discovered_sources LIMIT 1) AS evidence`,
    );
    expect(result.rows[0]).toMatchObject({
      runs: 1,
      discovered: 1,
      sources: 0,
      status: "proposed",
    });
    expect(result.rows[0].evidence).toContain("officialImportRunId");
    expect(result.rows[0].evidence).toContain("candidacyId");
  });

  it("rejects malformed, cross-election, and mismatched ownership inputs atomically", async () => {
    await setupOfficialImport();
    const strictUnknown = await readDiscovery();
    const strictUnknownValue = {
      ...structuredClone(strictUnknown),
      unexpected: true,
    };
    const nestedUnknown = await readDiscovery();
    const nestedUnknownValue = {
      ...structuredClone(nestedUnknown),
      run: {
        ...structuredClone(nestedUnknown.run),
        unexpected: true,
      },
    };
    for (const invalidBytes of [
      new Uint8Array(),
      new Uint8Array(65_537),
      new Uint8Array([0xff]),
      new TextEncoder().encode("{}"),
      new TextEncoder().encode(JSON.stringify(strictUnknownValue)),
      new TextEncoder().encode(JSON.stringify(nestedUnknownValue)),
    ]) {
      await expect(
        recordDiscoveryFixture(db, invalidBytes),
      ).rejects.toThrow(DiscoveryValidationError);
    }
    const boundaryStages = await db.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
         FROM stage_runs
        WHERE stage = 'discovery-record'`,
    );
    expect(boundaryStages.rows[0].count).toBe(0);

    const crossElection = await readDiscovery();
    crossElection.run.electionDate = "2027-10-25";
    await expect(
      recordDiscoveryFixture(db, encodeDiscovery(crossElection)),
    ).rejects.toThrow(DiscoveryValidationError);

    const mismatched = await readDiscovery();
    mismatched.results[0].ownershipEvidence.candidacy.officialImport.sourceUrl =
      "https://example.invalid/municipal-election/other.json";
    await expect(
      recordDiscoveryFixture(db, encodeDiscovery(mismatched)),
    ).rejects.toThrow(DiscoveryValidationError);

    const counts = await db.query<{
      runs: number;
      discovered: number;
      stages: number;
    }>(
      `SELECT
        (SELECT COUNT(*)::integer FROM discovery_runs) AS runs,
        (SELECT COUNT(*)::integer FROM discovered_sources) AS discovered,
        (SELECT COUNT(*)::integer FROM stage_runs
          WHERE stage = 'discovery-record') AS stages`,
    );
    expect(counts.rows[0]).toEqual({
      runs: 0,
      discovered: 0,
      stages: 2,
    });
  });

  it("rejects discovery ordering, URL, evidence-key, and duplicate-result edges", async () => {
    await setupOfficialImport();
    const reversed = await readDiscovery();
    reversed.run.completedAt = "2026-07-24T16:00:00.000Z";
    await expect(
      recordDiscoveryFixture(db, encodeDiscovery(reversed)),
    ).rejects.toThrow(DiscoveryValidationError);

    const nonCanonical = await readDiscovery();
    nonCanonical.results[0].canonicalUrl = "https://example.invalid";
    await expect(
      recordDiscoveryFixture(db, encodeDiscovery(nonCanonical)),
    ).rejects.toThrow(DiscoveryValidationError);

    for (const unsafeUrl of [
      "javascript:alert(1)",
      "ftp://example.invalid/platform",
      "https://user:pass@example.invalid/platform",
      "http://localhost/platform",
      "http://127.0.0.1/platform",
      "http://10.0.0.1/platform",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/platform",
    ]) {
      const unsafe = await readDiscovery();
      unsafe.results[0].observedUrl = unsafeUrl;
      unsafe.results[0].canonicalUrl = unsafeUrl;
      unsafe.results[0].ownershipEvidence.sourceAssociation.observedUrl =
        unsafeUrl;
      await expect(
        recordDiscoveryFixture(db, encodeDiscovery(unsafe)),
      ).rejects.toThrow(DiscoveryValidationError);
    }

    const unrelatedCanonical = await readDiscovery();
    unrelatedCanonical.results[0].observedUrl =
      "https://candidate.example.invalid/self-identification";
    unrelatedCanonical.results[0].ownershipEvidence.sourceAssociation.observedUrl =
      "https://candidate.example.invalid/self-identification";
    unrelatedCanonical.results[0].canonicalUrl =
      "https://unrelated.example.invalid/platform";
    await expect(
      recordDiscoveryFixture(db, encodeDiscovery(unrelatedCanonical)),
    ).rejects.toThrow(DiscoveryValidationError);

    const unrelatedPath = await readDiscovery();
    unrelatedPath.results[0].observedUrl =
      "https://example.invalid/self-identification";
    unrelatedPath.results[0].ownershipEvidence.sourceAssociation.observedUrl =
      "https://example.invalid/self-identification";
    unrelatedPath.results[0].canonicalUrl =
      "https://example.invalid/unrelated-candidate";
    await expect(
      recordDiscoveryFixture(db, encodeDiscovery(unrelatedPath)),
    ).rejects.toThrow(DiscoveryValidationError);

    const wrongObservedUrl = await readDiscovery();
    wrongObservedUrl.results[0].ownershipEvidence.sourceAssociation.observedUrl =
      "https://example.invalid/other";
    await expect(
      recordDiscoveryFixture(db, encodeDiscovery(wrongObservedUrl)),
    ).rejects.toThrow(DiscoveryValidationError);

    const wrongUpstreamKey = await readDiscovery();
    wrongUpstreamKey.results[0].ownershipEvidence.candidacy.upstreamKey =
      "candidate:other";
    await expect(
      recordDiscoveryFixture(db, encodeDiscovery(wrongUpstreamKey)),
    ).rejects.toThrow(DiscoveryValidationError);

    const duplicate = await readDiscovery();
    duplicate.results.push(structuredClone(duplicate.results[0]));
    await expect(
      recordDiscoveryFixture(db, encodeDiscovery(duplicate)),
    ).rejects.toThrow(DiscoveryValidationError);
  });

  it("requires acceptance before capture and preserves exact decision replay", async () => {
    await setupOfficialImport();
    const discovery = await recordDiscoveryFixture(
      db,
      await readFile(fixture("discovered-sources.json")),
    );
    const discoveredSourceId = discovery.discoveredSourceIds[0];
    const expectedSourceId = stableId(
      "source",
      (
        await db.query<{ candidacy_id: string }>(
          "SELECT candidacy_id FROM discovered_sources WHERE id = $1",
          [discoveredSourceId],
        )
      ).rows[0].candidacy_id,
      "https://example.invalid/demo-candidate/platform",
    );
    const html = await readFile(fixture("candidate-site.html"));

    await expect(
      captureWebsiteFixture(db, {
        sourceId: expectedSourceId,
        canonicalUrl: "https://example.invalid/demo-candidate/platform",
        originalUrl: "https://example.invalid/demo-candidate/platform",
        capturedAt: "2026-07-24T16:04:00.000Z",
        bytes: html,
      }),
    ).rejects.toThrow(SourceCaptureValidationError);

    const accepted = await acceptDiscoveredSource(
      db,
      discoveredSourceId,
      "2026-07-24T16:03:00.000Z",
      "Accepted fixture.",
    );
    const replay = await acceptDiscoveredSource(
      db,
      discoveredSourceId,
      "2026-07-24T18:00:00.000Z",
      "This must not replace the first note.",
    );
    expect(replay).toEqual(accepted);
    await db.query("DELETE FROM stage_runs WHERE stage = 'discovery-accept'");
    await expect(
      acceptDiscoveredSource(
        db,
        discoveredSourceId,
        "2026-07-24T18:00:00.000Z",
      ),
    ).resolves.toEqual(accepted);
    await expect(
      rejectDiscoveredSource(
        db,
        discoveredSourceId,
        "2026-07-24T18:01:00.000Z",
        "duplicate",
      ),
    ).rejects.toThrow(DiscoveryTransitionError);

    for (const invalidCapture of [
      {
        canonicalUrl: "javascript:alert(1)",
        originalUrl: "javascript:alert(1)",
      },
      {
        canonicalUrl:
          "https://user:pass@example.invalid/demo-candidate/platform",
        originalUrl:
          "https://user:pass@example.invalid/demo-candidate/platform",
      },
      {
        canonicalUrl: "https://example.invalid/demo-candidate/platform",
        originalUrl: "https://example.invalid/unrelated",
      },
    ]) {
      await expect(
        captureWebsiteFixture(db, {
          sourceId: accepted.sourceId!,
          ...invalidCapture,
          capturedAt: "2026-07-24T16:04:30.000Z",
          bytes: html,
        }),
      ).rejects.toThrow(SourceCaptureValidationError);
    }
    const beforeCapture = await db.query<{
      snapshots: number;
      observations: number;
    }>(
      `SELECT
        (SELECT COUNT(*)::integer FROM source_snapshots) AS snapshots,
        (SELECT COUNT(*)::integer FROM capture_observations) AS observations`,
    );
    expect(beforeCapture.rows[0]).toEqual({
      snapshots: 0,
      observations: 0,
    });

    await expect(
      captureWebsiteFixture(db, {
        sourceId: accepted.sourceId!,
        canonicalUrl: "https://example.invalid/demo-candidate/platform",
        originalUrl: "https://example.invalid/demo-candidate/platform",
        capturedAt: "2026-07-24T16:05:00.000Z",
        bytes: html,
      }),
    ).resolves.toMatchObject({ sourceId: accepted.sourceId });

    await expect(
      captureWebsiteFixture(db, {
        sourceId: accepted.sourceId!,
        canonicalUrl: "https://example.invalid/demo-candidate/platform",
        originalUrl: "https://example.invalid/demo-candidate/platform",
        capturedAt: "2026-07-24T16:05:00.000Z",
        bytes: new TextEncoder().encode("<html>Different capture</html>"),
      }),
    ).rejects.toThrow(SourceCaptureValidationError);
    const captureCounts = await db.query<{
      snapshots: number;
      observations: number;
    }>(
      `SELECT
        (SELECT COUNT(*)::integer FROM source_snapshots) AS snapshots,
        (SELECT COUNT(*)::integer FROM capture_observations) AS observations`,
    );
    expect(captureCounts.rows[0]).toEqual({
      snapshots: 1,
      observations: 1,
    });

    await db.query("UPDATE sources SET active = false WHERE id = $1", [
      accepted.sourceId,
    ]);
    await expect(
      captureWebsiteFixture(db, {
        sourceId: accepted.sourceId!,
        canonicalUrl: "https://example.invalid/demo-candidate/platform",
        originalUrl: "https://example.invalid/demo-candidate/platform",
        capturedAt: "2026-07-24T16:05:00.000Z",
        bytes: html,
      }),
    ).rejects.toThrow(SourceCaptureValidationError);
    const captureAttempts = await db.query<{
      attempt: number;
      status: string;
      error_code: string | null;
    }>(
      `SELECT attempt, status, error_code
         FROM stage_runs
        WHERE stage = 'capture'
          AND started_at = '2026-07-24T16:05:00.000Z'
          AND idempotency_key = (
            SELECT idempotency_key
              FROM stage_runs
             WHERE stage = 'capture'
               AND started_at = '2026-07-24T16:05:00.000Z'
               AND status = 'succeeded'
             LIMIT 1
          )
        ORDER BY attempt`,
    );
    expect(captureAttempts.rows).toEqual([
      { attempt: 1, status: "succeeded", error_code: null },
      {
        attempt: 2,
        status: "failed",
        error_code: "source_capture_validation",
      },
    ]);
    const decision = await db.query<{
      reviewed_at: string;
      reviewer_note: string;
    }>(
      `SELECT reviewed_at::text, reviewer_note
         FROM discovered_sources WHERE id = $1`,
      [discoveredSourceId],
    );
    expect(new Date(decision.rows[0].reviewed_at).toISOString()).toBe(
      "2026-07-24T16:03:00.000Z",
    );
    expect(decision.rows[0].reviewer_note).toBe("Accepted fixture.");
  });

  it("rejects terminal transition reversal and never creates a source", async () => {
    await setupOfficialImport();
    const discovery = await recordDiscoveryFixture(
      db,
      await readFile(fixture("discovered-sources.json")),
    );
    const id = discovery.discoveredSourceIds[0];
    const rejected = await rejectDiscoveredSource(
      db,
      id,
      "2026-07-24T16:03:00.000Z",
      "ownership-not-established",
      "Ownership evidence was insufficient.",
    );
    expect(rejected).toEqual({
      discoveredSourceId: id,
      status: "rejected",
      sourceId: null,
    });
    await expect(
      rejectDiscoveredSource(
        db,
        id,
        "2026-07-24T16:03:15.000Z",
        "duplicate",
        "A conflicting later rationale.",
      ),
    ).rejects.toThrow(DiscoveryTransitionError);
    await db.query("DELETE FROM stage_runs WHERE stage = 'discovery-reject'");
    await expect(
      rejectDiscoveredSource(
        db,
        id,
        "2026-07-24T16:03:30.000Z",
        "ownership-not-established",
      ),
    ).resolves.toEqual(rejected);
    await expect(
      acceptDiscoveredSource(db, id, "2026-07-24T16:04:00.000Z"),
    ).rejects.toThrow(DiscoveryTransitionError);
    const sources = await db.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM sources",
    );
    expect(sources.rows[0].count).toBe(0);
  });

  it("validates review timestamps, notes, reasons, and result identity", async () => {
    await setupOfficialImport();
    const discovery = await recordDiscoveryFixture(
      db,
      await readFile(fixture("discovered-sources.json")),
    );
    const id = discovery.discoveredSourceIds[0];
    await expect(
      acceptDiscoveredSource(db, id, "not-a-time"),
    ).rejects.toThrow(DiscoveryTransitionError);
    await expect(
      acceptDiscoveredSource(db, id, "2026-07-24T16:03:00.000Z", " "),
    ).rejects.toThrow(DiscoveryTransitionError);
    await expect(
      rejectDiscoveredSource(
        db,
        id,
        "2026-07-24T16:03:00.000Z",
        "invalid" as "duplicate",
      ),
    ).rejects.toThrow(DiscoveryTransitionError);
    await expect(
      acceptDiscoveredSource(
        db,
        "missing",
        "2026-07-24T16:03:00.000Z",
      ),
    ).rejects.toThrow(DiscoveryTransitionError);
  });

  it("reuses a compatible source on later rediscovery and rejects conflicting metadata", async () => {
    await setupOfficialImport();
    const firstFixture = await readDiscovery();
    const first = await recordDiscoveryFixture(
      db,
      encodeDiscovery(firstFixture),
    );
    const accepted = await acceptDiscoveredSource(
      db,
      first.discoveredSourceIds[0],
      "2026-07-24T16:03:00.000Z",
    );

    const laterFixture = structuredClone(firstFixture);
    laterFixture.run.startedAt = "2026-07-25T16:01:00.000Z";
    laterFixture.run.completedAt = "2026-07-25T16:02:00.000Z";
    laterFixture.results[0].observedAt = "2026-07-25T15:59:00.000Z";
    laterFixture.results[0].ownershipEvidence.sourceAssociation.observedAt =
      "2026-07-25T15:59:00.000Z";
    const later = await recordDiscoveryFixture(
      db,
      encodeDiscovery(laterFixture),
    );
    const acceptedLater = await acceptDiscoveredSource(
      db,
      later.discoveredSourceIds[0],
      "2026-07-25T16:03:00.000Z",
    );
    expect(acceptedLater.sourceId).toBe(accepted.sourceId);
    const counts = await db.query<{ sources: number; accepted: number }>(
      `SELECT
        (SELECT COUNT(*)::integer FROM sources) AS sources,
        (SELECT COUNT(*)::integer FROM discovered_sources
          WHERE status = 'accepted') AS accepted`,
    );
    expect(counts.rows[0]).toEqual({ sources: 1, accepted: 2 });
  });

  it("rolls back source creation when the acceptance transition fails", async () => {
    await setupOfficialImport();
    const discovery = await recordDiscoveryFixture(
      db,
      await readFile(fixture("discovered-sources.json")),
    );
    await db.exec(
      `ALTER TABLE discovered_sources
         ADD CONSTRAINT test_reject_acceptance
         CHECK (status <> 'accepted') NOT VALID`,
    );
    await expect(
      acceptDiscoveredSource(
        db,
        discovery.discoveredSourceIds[0],
        "2026-07-24T16:03:00.000Z",
      ),
    ).rejects.toThrow();
    const state = await db.query<{ sources: number; status: string }>(
      `SELECT
        (SELECT COUNT(*)::integer FROM sources) AS sources,
        (SELECT status FROM discovered_sources LIMIT 1) AS status`,
    );
    expect(state.rows[0]).toEqual({ sources: 0, status: "proposed" });
  });

  it("rejects a pre-existing source whose metadata conflicts", async () => {
    await setupOfficialImport();
    const discovery = await recordDiscoveryFixture(
      db,
      await readFile(fixture("discovered-sources.json")),
    );
    const row = await db.query<{
      candidacy_id: string;
      canonical_url: string;
    }>(
      `SELECT candidacy_id, canonical_url
         FROM discovered_sources WHERE id = $1`,
      [discovery.discoveredSourceIds[0]],
    );
    await db.query(
      `INSERT INTO sources (
         id, candidacy_id, source_type, title, canonical_url,
         attribution_policy, active
       ) VALUES ($1, $2, 'website', 'Conflicting title', $3,
                 'candidate_owned', true)`,
      [
        stableId("source", row.rows[0].candidacy_id, row.rows[0].canonical_url),
        row.rows[0].candidacy_id,
        row.rows[0].canonical_url,
      ],
    );
    await expect(
      acceptDiscoveredSource(
        db,
        discovery.discoveredSourceIds[0],
        "2026-07-24T16:03:00.000Z",
      ),
    ).rejects.toThrow(DiscoverySourceConflictError);
  });
});
