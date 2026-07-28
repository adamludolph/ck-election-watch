import type { PGlite } from "@electric-sql/pglite";
import { canonicalize } from "json-canonicalize";
import {
  EditorialRecordNotFoundError,
  PublicationPolicyError,
} from "@/lib/core/errors";
import { sha256 } from "@/lib/core/hash";
import type { PublishedStatementPayloadV1 } from "@/lib/publication/payload";
import { evaluateAttribution } from "@/lib/review/policy";

type QueryClient = Pick<PGlite, "query">;

type SubjectRow = {
  statement_id: string;
  extraction_run_id: string;
  extraction_item_id: string;
  extraction_status: string;
  status: string;
  summary: string;
  attribution_type: "candidate" | "campaign";
  candidacy_id: string;
  candidacy_slug: string;
  source_id: string;
  source_candidacy_id: string;
  source_relationship:
    | "candidate_owned"
    | "official_campaign"
    | "third_party";
  evidence_id: string;
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
  snapshot_id: string;
  snapshot_sha256: string;
  snapshot_bytes: Uint8Array;
  snapshot_byte_length: number;
  extraction_snapshot_id: string;
};

type IssueRow = {
  id: string;
  slug: string;
  label: string;
};

export type EditorialSubject = {
  statementId: string;
  status: string;
  digest: string;
  payload: PublishedStatementPayloadV1;
};

function validateSubjectRow(row: SubjectRow): void {
  if (
    row.candidacy_id !== row.source_candidacy_id ||
    row.extraction_snapshot_id !== row.block_snapshot_id ||
    row.snapshot_id !== row.block_snapshot_id
  ) {
    throw new PublicationPolicyError(
      "Statement, source, extraction, and evidence provenance do not agree.",
    );
  }
  if (row.extraction_status !== "succeeded") {
    throw new PublicationPolicyError(
      "Statement extraction was not successful.",
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

export async function loadEditorialSubject(
  db: QueryClient,
  statementId: string,
): Promise<EditorialSubject> {
  const result = await db.query<SubjectRow>(
    `SELECT
       st.id AS statement_id,
       st.extraction_run_id,
       st.extraction_item_id,
       er.status AS extraction_status,
       st.status,
       st.summary,
       st.attribution_type,
       st.candidacy_id,
       c.slug AS candidacy_slug,
       src.id AS source_id,
       src.candidacy_id AS source_candidacy_id,
       src.attribution_policy AS source_relationship,
       e.id AS evidence_id,
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
       ss.id AS snapshot_id,
       ss.content_sha256 AS snapshot_sha256,
       ss.raw_content AS snapshot_bytes,
       ss.byte_length AS snapshot_byte_length,
       er.snapshot_id AS extraction_snapshot_id
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
  if (result.rows.length === 0) {
    throw new EditorialRecordNotFoundError();
  }
  if (result.rows.length !== 1) {
    throw new PublicationPolicyError(
      "Statement must have exactly one supporting evidence record.",
    );
  }
  const row = result.rows[0];
  validateSubjectRow(row);

  const issueResult = await db.query<IssueRow>(
    `SELECT i.id, i.slug, i.label
       FROM statement_issues si
       JOIN issues i ON i.id = si.issue_id
      WHERE si.statement_id = $1
      ORDER BY i.slug, i.id`,
    [statementId],
  );
  if (issueResult.rows.length === 0) {
    throw new PublicationPolicyError(
      "Statement must have at least one controlled issue.",
    );
  }

  const payload: PublishedStatementPayloadV1 = {
    version: "1",
    statementId: row.statement_id,
    candidacySlug: row.candidacy_slug,
    summary: row.summary,
    issues: issueResult.rows.map(({ slug, label }) => ({ slug, label })),
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
  const digest = sha256(
    canonicalize({
      payload,
      provenance: {
        statementId: row.statement_id,
        extractionRunId: row.extraction_run_id,
        extractionItemId: row.extraction_item_id,
        candidacyId: row.candidacy_id,
        candidacySlug: row.candidacy_slug,
        attributionType: row.attribution_type,
        sourceId: row.source_id,
        sourceCandidacyId: row.source_candidacy_id,
        sourceRelationship: row.source_relationship,
        evidenceId: row.evidence_id,
        normalizedBlockId: row.block_id,
        normalizedBlockSha256: row.block_text_sha256,
        snapshotId: row.snapshot_id,
        snapshotSha256: row.snapshot_sha256,
      },
      issues: issueResult.rows,
    }),
  );

  return {
    statementId: row.statement_id,
    status: row.status,
    digest,
    payload,
  };
}
