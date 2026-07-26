import type { PGlite } from "@electric-sql/pglite";
import { SourceCaptureValidationError } from "@/lib/core/errors";
import { sha256, stableId } from "@/lib/core/hash";
import { canonicalPublicWebUrl } from "@/lib/core/url";
import { runStage } from "@/lib/pipeline/stage";

type QueryClient = Pick<PGlite, "query">;

export type CaptureInput = {
  sourceId: string;
  canonicalUrl: string;
  originalUrl: string;
  capturedAt: string;
  bytes: Uint8Array;
};

async function assertCaptureEligible(
  db: QueryClient,
  sourceId: string,
  canonicalUrl: string,
): Promise<{ candidacyId: string }> {
  const result = await db.query<{ candidacy_id: string }>(
    `SELECT src.candidacy_id
       FROM sources src
      WHERE src.id = $1
        AND src.active = true
        AND src.source_type = 'website'
        AND src.attribution_policy = 'candidate_owned'
        AND src.canonical_url = $2
        AND EXISTS (
          SELECT 1
            FROM discovered_sources ds
           WHERE ds.accepted_source_id = src.id
             AND ds.status = 'accepted'
        )`,
    [sourceId, canonicalUrl],
  );
  if (!result.rows[0]) {
    throw new SourceCaptureValidationError(
      "Website source is not accepted and eligible for capture.",
    );
  }
  return { candidacyId: result.rows[0].candidacy_id };
}

export async function captureWebsiteFixture(
  db: PGlite,
  input: CaptureInput,
): Promise<{
  sourceId: string;
  snapshotId: string;
  snapshotSha256: string;
}> {
  const payloadBytes = Uint8Array.from(input.bytes);
  if (payloadBytes.byteLength === 0 || payloadBytes.byteLength > 256 * 1024) {
    throw new SourceCaptureValidationError(
      "Website fixture must contain 1–262144 bytes.",
    );
  }
  let canonical: string;
  let original: string;
  try {
    canonical = canonicalPublicWebUrl(input.canonicalUrl);
    original = canonicalPublicWebUrl(input.originalUrl);
  } catch (error) {
    throw new SourceCaptureValidationError(
      "Capture URL must be a canonical public HTTP(S) URL.",
      error,
    );
  }
  if (original !== canonical) {
    throw new SourceCaptureValidationError(
      "Fixture capture original URL must equal its accepted canonical URL.",
    );
  }
  const contentSha256 = sha256(payloadBytes);
  const snapshotId = stableId("snapshot", input.sourceId, contentSha256);
  const observationId = stableId(
    "observation",
    input.sourceId,
    input.capturedAt,
  );

  return runStage(
    db,
    {
      stage: "capture",
      idempotencyKey: `${input.sourceId}:${contentSha256}:${input.capturedAt}`,
      processorName: "saved-html-capture",
      processorVersion: "2",
      inputRefs: {
        sourceId: input.sourceId,
        canonicalUrl: canonical,
        contentSha256,
      },
      now: input.capturedAt,
      validateReplay: async () => {
        await assertCaptureEligible(db, input.sourceId, canonical);
      },
    },
    async (tx) => {
      await assertCaptureEligible(tx, input.sourceId, canonical);
      const existingObservation = await tx.query<{
        snapshot_id: string;
        requested_url: string;
        original_url: string;
        canonical_url: string;
        content_sha256: string;
      }>(
        `SELECT o.snapshot_id, o.requested_url, s.original_url,
                s.canonical_url, s.content_sha256
           FROM capture_observations o
           JOIN source_snapshots s ON s.id = o.snapshot_id
          WHERE o.source_id = $1 AND o.observed_at = $2`,
        [input.sourceId, input.capturedAt],
      );
      if (existingObservation.rows[0]) {
        const observation = existingObservation.rows[0];
        if (
          observation.snapshot_id !== snapshotId ||
          observation.requested_url !== original ||
          observation.original_url !== original ||
          observation.canonical_url !== canonical ||
          observation.content_sha256 !== contentSha256
        ) {
          throw new SourceCaptureValidationError(
            "Capture observation time conflicts with different source content.",
          );
        }
        return {
          sourceId: input.sourceId,
          snapshotId: observation.snapshot_id,
          snapshotSha256: observation.content_sha256,
        };
      }
      await tx.query(
        `INSERT INTO source_snapshots (
           id, source_id, captured_at, original_url, canonical_url,
           content_type, encoding, raw_content, byte_length, content_sha256
         ) VALUES ($1, $2, $3, $4, $5, 'text/html', 'utf-8', $6, $7, $8)
         ON CONFLICT (source_id, content_sha256) DO NOTHING`,
        [
          snapshotId,
          input.sourceId,
          input.capturedAt,
          original,
          canonical,
          payloadBytes,
          payloadBytes.byteLength,
          contentSha256,
        ],
      );
      await tx.query(
        `INSERT INTO capture_observations (
           id, source_id, snapshot_id, observed_at, requested_url
         ) VALUES ($1, $2, $3, $4, $5)`,
        [
          observationId,
          input.sourceId,
          snapshotId,
          input.capturedAt,
          original,
        ],
      );
      return {
        sourceId: input.sourceId,
        snapshotId,
        snapshotSha256: contentSha256,
      };
    },
  );
}
