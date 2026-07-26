import type { PGlite } from "@electric-sql/pglite";
import { canonicalize } from "json-canonicalize";
import {
  EvidenceMismatchError,
  ExtractionSchemaError,
} from "@/lib/core/errors";
import { sha256, stableId } from "@/lib/core/hash";
import {
  extractionResultV1Schema,
  type ExtractionResultV1,
} from "@/lib/ai/schema";
import { runStage } from "@/lib/pipeline/stage";
import { evaluateAttribution } from "@/lib/review/policy";

type RecordExtractionInput = {
  candidacyId: string;
  snapshotId: string;
  prompt: string;
  rawResult: unknown;
  now: string;
};

type BlockRow = {
  id: string;
  text: string;
};

type SnapshotContextRow = {
  candidacy_id: string;
  attribution_policy:
    | "candidate_owned"
    | "official_campaign"
    | "third_party";
};

export async function recordMockExtraction(
  db: PGlite,
  input: RecordExtractionInput,
): Promise<{
  extractionRunId: string;
  statementIds: string[];
  abstentionCount: number;
}> {
  const promptSha256 = sha256(input.prompt);
  const rawResultSha256 = sha256(
    JSON.stringify(input.rawResult) ?? "undefined",
  );
  const extractionRunId = stableId(
    "extraction",
    input.snapshotId,
    promptSha256,
    "fixture/mock-extractor-v1",
    "1",
  );

  return runStage(
    db,
    {
      stage: "extract",
      idempotencyKey: stableId(
        "extract-attempt",
        extractionRunId,
        input.candidacyId,
        rawResultSha256,
      ),
      processorName: "structured-extraction-recorder",
      processorVersion: "1",
      inputRefs: {
        candidacyId: input.candidacyId,
        snapshotId: input.snapshotId,
        promptSha256,
        rawResultSha256,
      },
      now: input.now,
    },
    async () => {
      const parsed = extractionResultV1Schema.safeParse(input.rawResult);
      if (!parsed.success) {
        throw new ExtractionSchemaError(
          "Extraction output does not match schema version 1.",
          parsed.error,
        );
      }
      const result: ExtractionResultV1 = parsed.data;
      const snapshotContext = await db.query<SnapshotContextRow>(
        `SELECT src.candidacy_id, src.attribution_policy
           FROM source_snapshots ss
           JOIN sources src ON src.id = ss.source_id
          WHERE ss.id = $1`,
        [input.snapshotId],
      );
      const source = snapshotContext.rows[0];
      if (!source || source.candidacy_id !== input.candidacyId) {
        throw new EvidenceMismatchError(
          "Extraction snapshot does not belong to the supplied candidacy.",
        );
      }
      const blocks = await db.query<BlockRow>(
        `SELECT id, text FROM normalized_blocks WHERE snapshot_id = $1`,
        [input.snapshotId],
      );
      const blockMap = new Map(
        blocks.rows.map((block) => [block.id, block]),
      );
      const controlledIssues = await db.query<{ slug: string }>(
        "SELECT slug FROM issues",
      );
      const issueSet = new Set(
        controlledIssues.rows.map((issue) => issue.slug),
      );
      const attributionByStatementId = new Map<
        string,
        "candidate" | "campaign"
      >();

      for (const item of result.items) {
        const block = blockMap.get(item.blockId);
        if (!block) {
          throw new EvidenceMismatchError(
            `Extraction references unknown block ${item.blockId}.`,
          );
        }
        if (item.kind === "statement") {
          if (
            block.text.slice(item.startOffset, item.endOffset) !== item.quote
          ) {
            throw new EvidenceMismatchError(
              `Quote offsets do not match block ${item.blockId}.`,
            );
          }
          if (item.issueSlugs.some((slug) => !issueSet.has(slug))) {
            throw new ExtractionSchemaError(
              "Extraction references an uncontrolled issue.",
            );
          }
          const attribution = evaluateAttribution({
            sourceRelationship: source.attribution_policy,
            speaker: item.attributedTo,
            explicit: true,
          });
          if (!attribution.eligible) {
            throw new ExtractionSchemaError(
              `Statement attribution is ineligible: ${attribution.reason}.`,
            );
          }
          attributionByStatementId.set(
            item.statementId,
            attribution.attributionType,
          );
        }
      }

      const existingRun = await db.query<{ raw_result: string }>(
        `SELECT raw_result::text AS raw_result
           FROM extraction_runs
          WHERE id = $1`,
        [extractionRunId],
      );
      if (existingRun.rows[0]) {
        if (
          canonicalize(JSON.parse(existingRun.rows[0].raw_result)) !==
          canonicalize(result)
        ) {
          throw new ExtractionSchemaError(
            "Extraction identity already exists with a different raw result.",
          );
        }
        const existingStatements = await db.query<{
          id: string;
          candidacy_id: string;
        }>(
          `SELECT id, candidacy_id
             FROM statements
            WHERE extraction_run_id = $1
            ORDER BY extraction_item_id`,
          [extractionRunId],
        );
        const expectedStatementCount = result.items.filter(
          (item) => item.kind === "statement",
        ).length;
        if (
          existingStatements.rows.length !== expectedStatementCount ||
          existingStatements.rows.some(
            (statement) => statement.candidacy_id !== input.candidacyId,
          )
        ) {
          throw new EvidenceMismatchError(
            "Existing extraction statements do not match the validated candidacy.",
          );
        }
        return {
          extractionRunId,
          statementIds: existingStatements.rows.map(
            (statement) => statement.id,
          ),
          abstentionCount: result.items.filter(
            (item) => item.kind === "abstain",
          ).length,
        };
      }

      await db.query(
        `INSERT INTO extraction_runs (
           id, snapshot_id, prompt_key, prompt_sha256, model, schema_version,
           status, raw_result, created_at
         ) VALUES (
           $1, $2, 'extract-statements', $3, 'fixture/mock-extractor-v1',
           '1', 'succeeded', $4::jsonb, $5
         )`,
        [
          extractionRunId,
          input.snapshotId,
          promptSha256,
          JSON.stringify(result),
          input.now,
        ],
      );
      const statementIds: string[] = [];
      for (const item of result.items) {
        if (item.kind === "abstain") {
          continue;
        }
        const statementId = stableId(
          "statement",
            extractionRunId,
            item.statementId,
          );
        const attributionType = attributionByStatementId.get(item.statementId);
        if (!attributionType) {
          throw new ExtractionSchemaError(
            "Eligible statement attribution was not recorded.",
          );
        }
        statementIds.push(statementId);
        await db.query(
          `INSERT INTO statements (
             id, extraction_run_id, extraction_item_id, candidacy_id, summary,
             attribution_type, status
           ) VALUES ($1, $2, $3, $4, $5, $6, 'draft')`,
          [
            statementId,
            extractionRunId,
            item.statementId,
            input.candidacyId,
            item.summary,
            attributionType,
          ],
        );
        const evidenceId = stableId(
          "evidence",
          statementId,
          item.blockId,
          String(item.startOffset),
          String(item.endOffset),
          sha256(item.quote),
        );
        await db.query(
          `INSERT INTO evidence (
             id, statement_id, normalized_block_id, quote, start_offset,
             end_offset
           ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            evidenceId,
            statementId,
            item.blockId,
            item.quote,
            item.startOffset,
            item.endOffset,
          ],
        );
        for (const issueSlug of item.issueSlugs) {
          await db.query(
            `INSERT INTO statement_issues (statement_id, issue_id)
             SELECT $1, id FROM issues WHERE slug = $2`,
            [statementId, issueSlug],
          );
        }
      }
      return {
        extractionRunId,
        statementIds,
        abstentionCount: result.items.filter((item) => item.kind === "abstain")
          .length,
      };
    },
  );
}
