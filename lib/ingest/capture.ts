import type { PGlite } from "@electric-sql/pglite";
import { SourceCaptureValidationError } from "@/lib/core/errors";
import { sha256, stableId } from "@/lib/core/hash";
import { runStage } from "@/lib/pipeline/stage";

export type CaptureInput = {
  candidacyId: string;
  sourceTitle: string;
  canonicalUrl: string;
  originalUrl: string;
  capturedAt: string;
  bytes: Uint8Array;
};

export async function captureWebsiteFixture(
  db: PGlite,
  input: CaptureInput,
): Promise<{
  sourceId: string;
  snapshotId: string;
  snapshotSha256: string;
}> {
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > 256 * 1024) {
    throw new SourceCaptureValidationError(
      "Website fixture must contain 1–262144 bytes.",
    );
  }
  let canonicalUrl: URL;
  try {
    canonicalUrl = new URL(input.canonicalUrl);
  } catch (error) {
    throw new SourceCaptureValidationError("Canonical URL is invalid.", error);
  }
  const contentSha256 = sha256(input.bytes);
  const sourceId = stableId(
    "source",
    input.candidacyId,
    canonicalUrl.toString(),
  );
  const snapshotId = stableId("snapshot", sourceId, contentSha256);
  const observationId = stableId(
    "observation",
    sourceId,
    input.capturedAt,
  );

  return runStage(
    db,
    {
      stage: "capture",
      idempotencyKey: `${sourceId}:${contentSha256}:${input.capturedAt}`,
      processorName: "saved-html-capture",
      processorVersion: "1",
      inputRefs: {
        candidacyId: input.candidacyId,
        canonicalUrl: canonicalUrl.toString(),
        contentSha256,
      },
      now: input.capturedAt,
    },
    async () => {
      await db.query(
        `INSERT INTO sources (
           id, candidacy_id, source_type, title, canonical_url,
           attribution_policy, active
         ) VALUES ($1, $2, 'website', $3, $4, 'candidate_owned', true)
         ON CONFLICT (candidacy_id, canonical_url) DO NOTHING`,
        [
          sourceId,
          input.candidacyId,
          input.sourceTitle,
          canonicalUrl.toString(),
        ],
      );
      await db.query(
        `INSERT INTO source_snapshots (
           id, source_id, captured_at, original_url, canonical_url,
           content_type, encoding, raw_content, byte_length, content_sha256
         ) VALUES ($1, $2, $3, $4, $5, 'text/html', 'utf-8', $6, $7, $8)
         ON CONFLICT (source_id, content_sha256) DO NOTHING`,
        [
          snapshotId,
          sourceId,
          input.capturedAt,
          input.originalUrl,
          canonicalUrl.toString(),
          input.bytes,
          input.bytes.byteLength,
          contentSha256,
        ],
      );
      await db.query(
        `INSERT INTO capture_observations (
           id, source_id, snapshot_id, observed_at, requested_url
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (source_id, observed_at) DO NOTHING`,
        [
          observationId,
          sourceId,
          snapshotId,
          input.capturedAt,
          input.originalUrl,
        ],
      );
      return { sourceId, snapshotId, snapshotSha256: contentSha256 };
    },
  );
}
