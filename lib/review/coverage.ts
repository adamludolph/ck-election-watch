import type { PGlite } from "@electric-sql/pglite";
import { PublicationPolicyError } from "@/lib/core/errors";
import { stableId } from "@/lib/core/hash";
import { runStage } from "@/lib/pipeline/stage";

type CompleteCoverageInput = {
  candidacyId: string;
  sourceId: string;
  snapshotId: string;
  extractionRunId: string;
  attemptedUrl: string;
  startedAt: string;
  completedAt: string;
};

export async function completeFixtureCoverage(
  db: PGlite,
  input: CompleteCoverageInput,
): Promise<{ researchRunId: string }> {
  const researchRunId = stableId(
    "research",
    input.candidacyId,
    "fixture-methodology-v1",
    input.attemptedUrl,
  );
  return runStage(
    db,
    {
      stage: "research-complete",
      idempotencyKey: researchRunId,
      processorName: "coverage-completion-policy",
      processorVersion: "1",
      inputRefs: {
        candidacyId: input.candidacyId,
        sourceId: input.sourceId,
        snapshotId: input.snapshotId,
        extractionRunId: input.extractionRunId,
      },
      now: input.completedAt,
    },
    async () => {
      const consistency = await db.query<{ valid: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM sources src
           JOIN source_snapshots ss ON ss.source_id = src.id
           JOIN extraction_runs er ON er.snapshot_id = ss.id
           WHERE src.id = $1
             AND ss.id = $2
             AND er.id = $3
             AND src.candidacy_id = $4
             AND $5 IN (src.canonical_url, ss.original_url)
         ) AS valid`,
        [
          input.sourceId,
          input.snapshotId,
          input.extractionRunId,
          input.candidacyId,
          input.attemptedUrl,
        ],
      );
      if (!consistency.rows[0]?.valid) {
        throw new PublicationPolicyError(
          "Coverage links do not describe one source snapshot extraction.",
        );
      }
      const scope = [input.attemptedUrl];
      await db.query(
        `INSERT INTO research_runs (
           id, candidacy_id, methodology_version, source_scope, status,
           started_at
         ) VALUES ($1, $2, 'fixture-methodology-v1', $3::jsonb, 'running', $4)`,
        [
          researchRunId,
          input.candidacyId,
          JSON.stringify(scope),
          input.startedAt,
        ],
      );
      await db.query(
        `INSERT INTO research_run_sources (
           id, research_run_id, source_id, attempted_url, outcome, snapshot_id,
           extraction_run_id, reviewed_at, observed_at
         ) VALUES ($1, $2, $3, $4, 'captured', $5, $6, $7, $7)`,
        [
          stableId("research-source", researchRunId, input.attemptedUrl),
          researchRunId,
          input.sourceId,
          input.attemptedUrl,
          input.snapshotId,
          input.extractionRunId,
          input.completedAt,
        ],
      );
      const attempts = await db.query<{ attempted_url: string }>(
        `SELECT attempted_url
           FROM research_run_sources
          WHERE research_run_id = $1
            AND outcome = 'captured'
            AND snapshot_id IS NOT NULL
            AND extraction_run_id IS NOT NULL
            AND reviewed_at IS NOT NULL`,
        [researchRunId],
      );
      if (
        attempts.rows.length !== scope.length ||
        attempts.rows[0]?.attempted_url !== scope[0]
      ) {
        throw new PublicationPolicyError(
          "Research scope is not completely captured and reviewed.",
        );
      }
      await db.query(
        `UPDATE research_runs
            SET status = 'completed', completed_at = $1
          WHERE id = $2`,
        [input.completedAt, researchRunId],
      );
      return { researchRunId };
    },
  );
}
