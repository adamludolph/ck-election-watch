import type { PGlite } from "@electric-sql/pglite";
import {
  EditorialRecordNotFoundError,
  PublicationPolicyError,
} from "@/lib/core/errors";
import { loadEditorialSubject } from "@/lib/editorial/subject";
import type { EditorialPhase } from "@/lib/editorial/types";

type QueueRow = {
  statement_id: string;
  candidate_name: string;
  candidacy_slug: string;
  summary: string;
  status: string;
  issue_label: string;
  source_title: string;
  captured_at: string;
  latest_event: string | null;
  latest_time: string | null;
  active_publication: boolean;
  prior_unpublication: boolean;
};

export type ReviewQueueRecord = {
  statementId: string;
  candidateName: string;
  candidacySlug: string;
  summary: string;
  phase: EditorialPhase;
  issueLabel: string;
  sourceTitle: string;
  capturedAt: string;
  latestTime: string | null;
};

export const reviewFilterLabels: Array<{
  value: "all" | EditorialPhase;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "needs_review", label: "Needs review" },
  { value: "changes_requested", label: "Changes requested" },
  { value: "ready_to_approve", label: "Ready to approve" },
  { value: "approved_unpublished", label: "Approved unpublished" },
  { value: "published", label: "Published" },
  { value: "rejected", label: "Rejected" },
  { value: "withdrawn", label: "Withdrawn" },
];

export function deriveEditorialPhase(
  row: Pick<
    QueueRow,
    | "status"
    | "latest_event"
    | "active_publication"
    | "prior_unpublication"
  >,
): EditorialPhase {
  if (row.status === "rejected") {
    return "rejected";
  }
  if (row.status === "withdrawn") {
    return "withdrawn";
  }
  if (row.status === "approved") {
    if (row.active_publication) {
      return "published";
    }
    return "approved_unpublished";
  }
  if (row.status !== "draft") {
    throw new PublicationPolicyError(
      `Unsupported editorial status ${row.status}.`,
    );
  }
  if (row.latest_event === "reviewed_ready") {
    return "ready_to_approve";
  }
  if (row.latest_event === "reviewed_changes_requested") {
    return "changes_requested";
  }
  return "needs_review";
}

async function loadQueueRows(db: PGlite): Promise<QueueRow[]> {
  const result = await db.query<QueueRow>(
    `SELECT
       st.id AS statement_id,
       person.display_name AS candidate_name,
       c.slug AS candidacy_slug,
       st.summary,
       st.status,
       string_agg(DISTINCT i.label, ', ' ORDER BY i.label) AS issue_label,
       src.title AS source_title,
       ss.captured_at::text,
       latest.event_type AS latest_event,
       latest.occurred_at::text AS latest_time,
       EXISTS (
         SELECT 1 FROM active_publication_payloads active
          WHERE active.statement_id = st.id
       ) AS active_publication,
       EXISTS (
         SELECT 1
           FROM publications p2
           JOIN publication_events pe2 ON pe2.publication_id = p2.id
          WHERE p2.statement_id = st.id
            AND pe2.event_type = 'unpublished'
       ) AS prior_unpublication
     FROM statements st
     JOIN candidacies c ON c.id = st.candidacy_id
     JOIN people person ON person.id = c.person_id
     JOIN statement_issues si ON si.statement_id = st.id
     JOIN issues i ON i.id = si.issue_id
     JOIN evidence e ON e.statement_id = st.id
     JOIN normalized_blocks nb ON nb.id = e.normalized_block_id
     JOIN source_snapshots ss ON ss.id = nb.snapshot_id
     JOIN sources src ON src.id = ss.source_id
     LEFT JOIN LATERAL (
       SELECT event_type, occurred_at
         FROM statement_editorial_events see
        WHERE see.statement_id = st.id
        ORDER BY sequence DESC
        LIMIT 1
     ) latest ON true
     GROUP BY
       st.id, person.display_name, c.slug, st.summary, st.status, src.title,
       ss.captured_at, latest.event_type, latest.occurred_at
     ORDER BY ss.captured_at, st.summary, st.id`,
  );
  return result.rows;
}

export async function getReviewQueue(
  db: PGlite,
  filter: "all" | EditorialPhase = "needs_review",
): Promise<{
  records: ReviewQueueRecord[];
  counts: Record<"all" | EditorialPhase, number>;
}> {
  const records = (await loadQueueRows(db)).map((row) => ({
    statementId: row.statement_id,
    candidateName: row.candidate_name,
    candidacySlug: row.candidacy_slug,
    summary: row.summary,
    phase: deriveEditorialPhase(row),
    issueLabel: row.issue_label,
    sourceTitle: row.source_title,
    capturedAt: new Date(row.captured_at).toISOString(),
    latestTime: row.latest_time
      ? new Date(row.latest_time).toISOString()
      : null,
  }));
  const counts = Object.fromEntries(
    reviewFilterLabels.map(({ value }) => [
      value,
      value === "all"
        ? records.length
        : records.filter((record) => record.phase === value).length,
    ]),
  ) as Record<"all" | EditorialPhase, number>;
  return {
    records:
      filter === "all"
        ? records
        : records.filter((record) => record.phase === filter),
    counts,
  };
}

type DetailRow = QueueRow & {
  extraction_run_id: string;
  extraction_item_id: string;
  model: string;
  schema_version: string;
  evidence_quote: string;
  start_offset: number;
  end_offset: number;
  normalized_block_id: string;
  normalized_text: string;
  normalized_text_sha256: string;
  snapshot_id: string;
  snapshot_sha256: string;
  snapshot_byte_length: number;
  original_url: string;
  raw_content: Uint8Array;
};

export type ReviewHistoryItem = {
  requestId: string;
  eventTypes: string[];
  operatorRef: string;
  note: string | null;
  reason: string | null;
  occurredAt: string;
};

export type ReviewStatementRecord = ReviewQueueRecord & {
  extractionRunId: string;
  extractionItemId: string;
  model: string;
  schemaVersion: string;
  evidenceQuote: string;
  startOffset: number;
  endOffset: number;
  normalizedBlockId: string;
  normalizedText: string;
  normalizedTextSha256: string;
  snapshotId: string;
  snapshotSha256: string;
  snapshotByteLength: number;
  originalUrl: string;
  rawSnapshot: string;
  reviewSubjectSha256: string | null;
  blockedReason: string | null;
  history: ReviewHistoryItem[];
};

export async function getReviewStatement(
  db: PGlite,
  statementId: string,
): Promise<ReviewStatementRecord> {
  const result = await db.query<DetailRow>(
    `SELECT
       st.id AS statement_id,
       person.display_name AS candidate_name,
       c.slug AS candidacy_slug,
       st.summary,
       st.status,
       string_agg(DISTINCT i.label, ', ' ORDER BY i.label) AS issue_label,
       src.title AS source_title,
       ss.captured_at::text,
       latest.event_type AS latest_event,
       latest.occurred_at::text AS latest_time,
       EXISTS (
         SELECT 1 FROM active_publication_payloads active
          WHERE active.statement_id = st.id
       ) AS active_publication,
       EXISTS (
         SELECT 1
           FROM publications p2
           JOIN publication_events pe2 ON pe2.publication_id = p2.id
          WHERE p2.statement_id = st.id
            AND pe2.event_type = 'unpublished'
       ) AS prior_unpublication,
       st.extraction_run_id,
       st.extraction_item_id,
       er.model,
       er.schema_version,
       e.quote AS evidence_quote,
       e.start_offset,
       e.end_offset,
       nb.id AS normalized_block_id,
       nb.text AS normalized_text,
       nb.text_sha256 AS normalized_text_sha256,
       ss.id AS snapshot_id,
       ss.content_sha256 AS snapshot_sha256,
       ss.byte_length AS snapshot_byte_length,
       ss.original_url,
       ss.raw_content
     FROM statements st
     JOIN candidacies c ON c.id = st.candidacy_id
     JOIN people person ON person.id = c.person_id
     JOIN extraction_runs er ON er.id = st.extraction_run_id
     JOIN statement_issues si ON si.statement_id = st.id
     JOIN issues i ON i.id = si.issue_id
     JOIN evidence e ON e.statement_id = st.id
     JOIN normalized_blocks nb ON nb.id = e.normalized_block_id
     JOIN source_snapshots ss ON ss.id = nb.snapshot_id
     JOIN sources src ON src.id = ss.source_id
     LEFT JOIN LATERAL (
       SELECT event_type, occurred_at
         FROM statement_editorial_events see
        WHERE see.statement_id = st.id
        ORDER BY sequence DESC
        LIMIT 1
     ) latest ON true
     WHERE st.id = $1
     GROUP BY
       st.id, person.display_name, c.slug, st.summary, st.status, src.title,
       ss.captured_at, latest.event_type, latest.occurred_at,
       st.extraction_run_id, st.extraction_item_id, er.model,
       er.schema_version, e.quote, e.start_offset, e.end_offset, nb.id, nb.text,
       nb.text_sha256, ss.id, ss.content_sha256, ss.byte_length,
       ss.original_url, ss.raw_content`,
    [statementId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new EditorialRecordNotFoundError();
  }
  const phase = deriveEditorialPhase(row);

  let subjectDigest: string | null = null;
  let blockedReason: string | null = null;
  try {
    subjectDigest = (await loadEditorialSubject(db, statementId)).digest;
  } catch (error) {
    if (error instanceof PublicationPolicyError) {
      blockedReason = error.message;
    } else {
      throw error;
    }
  }

  const historyResult = await db.query<{
    id: string;
    request_id: string;
    event_type: string;
    operator_ref: string;
    note: string | null;
    reason: string | null;
    occurred_at: string;
    source_kind: string;
  }>(
    `SELECT
       see.id,
       see.request_id,
       see.event_type,
       see.operator_ref,
       see.note,
       see.reason,
       see.occurred_at::text,
       'editorial' AS source_kind
     FROM statement_editorial_events see
     WHERE see.statement_id = $1
     UNION ALL
     SELECT
       pe.id,
       pe.request_id,
       pe.event_type,
       pe.operator_ref,
       NULL AS note,
       pe.reason,
       pe.occurred_at::text,
       'publication' AS source_kind
     FROM publications p
     JOIN publication_events pe ON pe.publication_id = p.id
     WHERE p.statement_id = $1
      ORDER BY occurred_at, source_kind DESC, id`,
    [statementId],
  );
  const grouped = new Map<string, ReviewHistoryItem>();
  for (const event of historyResult.rows) {
    const actionGroup =
      event.event_type === "withdrawn" ? "unpublished" : event.event_type;
    const groupKey = `${actionGroup}:${event.request_id}`;
    const existing = grouped.get(groupKey);
    if (existing) {
      existing.eventTypes.push(event.event_type);
      existing.note ??= event.note;
      existing.reason ??= event.reason;
    } else {
      grouped.set(groupKey, {
        requestId: event.request_id,
        eventTypes: [event.event_type],
        operatorRef: event.operator_ref,
        note: event.note,
        reason: event.reason,
        occurredAt: new Date(event.occurred_at).toISOString(),
      });
    }
  }

  return {
    statementId: row.statement_id,
    candidateName: row.candidate_name,
    candidacySlug: row.candidacy_slug,
    summary: row.summary,
    phase,
    issueLabel: row.issue_label,
    sourceTitle: row.source_title,
    capturedAt: new Date(row.captured_at).toISOString(),
    latestTime: row.latest_time
      ? new Date(row.latest_time).toISOString()
      : null,
    extractionRunId: row.extraction_run_id,
    extractionItemId: row.extraction_item_id,
    model: row.model,
    schemaVersion: row.schema_version,
    evidenceQuote: row.evidence_quote,
    startOffset: Number(row.start_offset),
    endOffset: Number(row.end_offset),
    normalizedBlockId: row.normalized_block_id,
    normalizedText: row.normalized_text,
    normalizedTextSha256: row.normalized_text_sha256,
    snapshotId: row.snapshot_id,
    snapshotSha256: row.snapshot_sha256,
    snapshotByteLength: Number(row.snapshot_byte_length),
    originalUrl: row.original_url,
    rawSnapshot: new TextDecoder("utf-8").decode(row.raw_content),
    reviewSubjectSha256: subjectDigest,
    blockedReason,
    history: [...grouped.values()],
  };
}
