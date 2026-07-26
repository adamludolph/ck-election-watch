import type { PGlite } from "@electric-sql/pglite";
import { PublicationPolicyError } from "@/lib/core/errors";
import { sha256, stableId } from "@/lib/core/hash";
import {
  digestPublicationPayload,
  type PublishedStatementPayloadV1,
} from "@/lib/publication/payload";
import { runStage } from "@/lib/pipeline/stage";
import { evaluateAttribution } from "@/lib/review/policy";

type QueryClient = Pick<PGlite, "query">;

type StatementEvidenceRow = {
  statement_id: string;
  status: string;
  summary: string;
  attribution_type: "candidate" | "campaign";
  candidacy_id: string;
  candidacy_slug: string;
  source_candidacy_id: string;
  source_relationship:
    | "candidate_owned"
    | "official_campaign"
    | "third_party";
  quote: string;
  start_offset: number;
  end_offset: number;
  block_id: string;
  block_text: string;
  block_text_sha256: string;
  block_snapshot_id: string;
  source_title: string;
  original_url: string;
  captured_at: string;
  snapshot_sha256: string;
  snapshot_bytes: Uint8Array;
  snapshot_byte_length: number;
  extraction_snapshot_id: string;
  extraction_status: string;
};

async function loadStatementEvidence(
  db: QueryClient,
  statementId: string,
): Promise<StatementEvidenceRow> {
  const result = await db.query<StatementEvidenceRow>(
    `SELECT
       st.id AS statement_id,
       st.status,
       st.summary,
       st.attribution_type,
       st.candidacy_id,
       c.slug AS candidacy_slug,
       src.candidacy_id AS source_candidacy_id,
       src.attribution_policy AS source_relationship,
       e.quote,
       e.start_offset,
       e.end_offset,
       nb.id AS block_id,
       nb.text AS block_text,
       nb.text_sha256 AS block_text_sha256,
       nb.snapshot_id AS block_snapshot_id,
       src.title AS source_title,
       ss.original_url,
       ss.captured_at::text,
       ss.content_sha256 AS snapshot_sha256,
       ss.raw_content AS snapshot_bytes,
       ss.byte_length AS snapshot_byte_length,
       er.snapshot_id AS extraction_snapshot_id,
       er.status AS extraction_status
     FROM statements st
     JOIN candidacies c ON c.id = st.candidacy_id
     JOIN extraction_runs er ON er.id = st.extraction_run_id
     JOIN evidence e ON e.statement_id = st.id
     JOIN normalized_blocks nb ON nb.id = e.normalized_block_id
     JOIN source_snapshots ss ON ss.id = nb.snapshot_id
     JOIN sources src ON src.id = ss.source_id
     WHERE st.id = $1`,
    [statementId],
  );
  if (result.rows.length !== 1) {
    throw new PublicationPolicyError(
      "Statement must have exactly one supporting evidence record.",
    );
  }
  return result.rows[0];
}

function validateStatementEvidence(row: StatementEvidenceRow): void {
  if (
    row.candidacy_id !== row.source_candidacy_id ||
    row.extraction_snapshot_id !== row.block_snapshot_id
  ) {
    throw new PublicationPolicyError(
      "Statement, source, extraction, and evidence provenance do not agree.",
    );
  }
  if (
    row.snapshot_bytes.byteLength !== Number(row.snapshot_byte_length) ||
    sha256(row.snapshot_bytes) !== row.snapshot_sha256
  ) {
    throw new PublicationPolicyError(
      "Source snapshot bytes do not match their immutable digest.",
    );
  }
  if (sha256(row.block_text) !== row.block_text_sha256) {
    throw new PublicationPolicyError(
      "Normalized evidence block does not match its digest.",
    );
  }
  if (
    row.block_text.slice(
      Number(row.start_offset),
      Number(row.end_offset),
    ) !== row.quote
  ) {
    throw new PublicationPolicyError(
      "Evidence quote does not match its normalized block offsets.",
    );
  }
  const attribution = evaluateAttribution({
    sourceRelationship: row.source_relationship,
    speaker: row.attribution_type,
    explicit: true,
  });
  if (!attribution.eligible) {
    throw new PublicationPolicyError(
      `Statement attribution is not publication-eligible: ${attribution.reason}.`,
    );
  }
}

async function buildPayload(
  db: QueryClient,
  row: StatementEvidenceRow,
): Promise<PublishedStatementPayloadV1> {
  const issues = await db.query<{ slug: string; label: string }>(
    `SELECT i.slug, i.label
       FROM statement_issues si
       JOIN issues i ON i.id = si.issue_id
      WHERE si.statement_id = $1
      ORDER BY i.slug`,
    [row.statement_id],
  );
  if (issues.rows.length === 0) {
    throw new PublicationPolicyError(
      "Statement must have at least one controlled issue.",
    );
  }
  return {
    version: "1",
    statementId: row.statement_id,
    candidacySlug: row.candidacy_slug,
    summary: row.summary,
    issues: issues.rows,
    evidence: {
      quote: row.quote,
      blockId: row.block_id,
      normalizedBlockText: row.block_text,
      startOffset: Number(row.start_offset),
      endOffset: Number(row.end_offset),
      sourceTitle: row.source_title,
      originalUrl: row.original_url,
      capturedAt: new Date(row.captured_at).toISOString(),
      snapshotSha256: row.snapshot_sha256,
    },
  };
}

async function writePublication(
  db: QueryClient,
  statementId: string,
  now: string,
  approve: boolean,
): Promise<{ publicationId: string; payloadSha256: string }> {
  const row = await loadStatementEvidence(db, statementId);
  validateStatementEvidence(row);
  if (row.extraction_status !== "succeeded") {
    throw new PublicationPolicyError(
      "Statement extraction was not successful.",
    );
  }
  if (approve) {
    if (row.status !== "draft" && row.status !== "approved") {
      throw new PublicationPolicyError(
        "Only a draft statement can be approved.",
      );
    }
    await db.query(
      `UPDATE statements
          SET status = 'approved', approved_at = COALESCE(approved_at, $1)
        WHERE id = $2`,
      [now, statementId],
    );
  } else if (row.status !== "approved") {
    throw new PublicationPolicyError(
      "Only an approved statement can be published.",
    );
  }
  const payload = await buildPayload(db, row);
  const payloadSha256 = digestPublicationPayload(payload);
  const publicationId = stableId("publication", statementId);
  await db.query(
    `INSERT INTO publications (
       id, statement_id, payload, payload_sha256, published_at
     ) VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (statement_id) DO NOTHING`,
    [
      publicationId,
      statementId,
      JSON.stringify(payload),
      payloadSha256,
      now,
    ],
  );
  const stored = await db.query<{ payload_sha256: string }>(
    "SELECT payload_sha256 FROM publications WHERE id = $1",
    [publicationId],
  );
  if (!stored.rows[0]) {
    throw new PublicationPolicyError("Publication was not persisted.");
  }
  return {
    publicationId,
    payloadSha256: stored.rows[0].payload_sha256,
  };
}

export function approveAndPublishStatement(
  db: PGlite,
  statementId: string,
  now: string,
): Promise<{ publicationId: string; payloadSha256: string }> {
  return runStage(
    db,
    {
      stage: "approve-publish",
      idempotencyKey: statementId,
      processorName: "publication-policy",
      processorVersion: "1",
      inputRefs: { statementId, approve: true },
      now,
    },
    (tx) => writePublication(tx, statementId, now, true),
  );
}

export function publishApprovedStatement(
  db: PGlite,
  statementId: string,
  now: string,
): Promise<{ publicationId: string; payloadSha256: string }> {
  return runStage(
    db,
    {
      stage: "publish",
      idempotencyKey: statementId,
      processorName: "publication-policy",
      processorVersion: "1",
      inputRefs: { statementId, approve: false },
      now,
    },
    (tx) => writePublication(tx, statementId, now, false),
  );
}
