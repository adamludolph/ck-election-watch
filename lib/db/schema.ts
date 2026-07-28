import {
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

const vector1536 = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector(1536)",
});

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });

export const municipalities = pgTable("municipalities", {
  id: text().primaryKey(),
  slug: text().notNull().unique(),
  name: text().notNull(),
});

export const elections = pgTable("elections", {
  id: text().primaryKey(),
  municipalityId: text("municipality_id")
    .notNull()
    .references(() => municipalities.id),
  name: text().notNull(),
  electionDate: date("election_date", { mode: "string" }).notNull(),
});

export const offices = pgTable("offices", {
  id: text().primaryKey(),
  electionId: text("election_id")
    .notNull()
    .references(() => elections.id),
  officeType: text("office_type").notNull(),
  name: text().notNull(),
  wardSlug: text("ward_slug"),
});

export const people = pgTable("people", {
  id: text().primaryKey(),
  displayName: text("display_name").notNull(),
});

export const candidacies = pgTable(
  "candidacies",
  {
    id: text().primaryKey(),
    electionId: text("election_id")
      .notNull()
      .references(() => elections.id),
    officeId: text("office_id")
      .notNull()
      .references(() => offices.id),
    personId: text("person_id")
      .notNull()
      .references(() => people.id),
    officialPersonKey: text("official_person_key"),
    slug: text().notNull(),
    status: text().notNull(),
  },
  (table) => [
    unique("candidacy_identity").on(
      table.electionId,
      table.officeId,
      table.personId,
    ),
    unique("candidacy_slug").on(table.electionId, table.slug),
  ],
);

export const officialImportRuns = pgTable(
  "official_import_runs",
  {
    id: text().primaryKey(),
    electionId: text("election_id")
      .notNull()
      .references(() => elections.id),
    sourceUrl: text("source_url").notNull(),
    observedAt: timestamptz("observed_at").notNull(),
    contentType: text("content_type").notNull(),
    encoding: text().notNull(),
    rawPayload: bytea("raw_payload").notNull(),
    byteLength: integer("byte_length").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    importedCount: integer("imported_count").notNull(),
  },
  (table) => [
    unique("official_import_logical_key").on(
      table.electionId,
      table.sourceUrl,
      table.observedAt,
    ),
    index("official_import_runs_election_observed_idx").on(
      table.electionId,
      table.observedAt.desc(),
    ),
    check(
      "official_import_runs_content_type_check",
      sql`${table.contentType} = 'application/json'`,
    ),
    check(
      "official_import_runs_encoding_check",
      sql`${table.encoding} = 'utf-8'`,
    ),
    check(
      "official_import_runs_byte_length_check",
      sql`${table.byteLength} > 0`,
    ),
    check(
      "official_import_runs_payload_sha256_check",
      sql`${table.payloadSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "official_import_runs_imported_count_check",
      sql`${table.importedCount} > 0`,
    ),
  ],
);

export const candidacyStatusHistory = pgTable(
  "candidacy_status_history",
  {
    id: text().primaryKey(),
    candidacyId: text("candidacy_id")
      .notNull()
      .references(() => candidacies.id),
    status: text().notNull(),
    observedAt: timestamptz("observed_at").notNull(),
    upstreamKey: text("upstream_key").notNull(),
    officialImportRunId: text("official_import_run_id").references(
      () => officialImportRuns.id,
    ),
  },
  (table) => [
    unique("candidacy_status_observed_unique").on(
      table.candidacyId,
      table.observedAt,
    ),
    index("candidacy_status_upstream_lookup_idx").on(
      table.upstreamKey,
      table.candidacyId,
      table.observedAt.desc(),
    ),
  ],
);

export const sources = pgTable(
  "sources",
  {
    id: text().primaryKey(),
    candidacyId: text("candidacy_id")
      .notNull()
      .references(() => candidacies.id),
    sourceType: text("source_type").notNull(),
    title: text().notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    attributionPolicy: text("attribution_policy").notNull(),
    active: boolean().notNull(),
  },
  (table) => [
    unique("sources_candidacy_canonical_url").on(
      table.candidacyId,
      table.canonicalUrl,
    ),
  ],
);

export const discoveryRuns = pgTable(
  "discovery_runs",
  {
    id: text().primaryKey(),
    electionId: text("election_id")
      .notNull()
      .references(() => elections.id),
    method: text().notNull(),
    methodVersion: text("method_version").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    startedAt: timestamptz("started_at").notNull(),
    completedAt: timestamptz("completed_at").notNull(),
  },
  (table) => [
    unique("discovery_run_logical_key").on(
      table.electionId,
      table.method,
      table.methodVersion,
      table.payloadSha256,
      table.startedAt,
    ),
    index("discovery_runs_election_started_idx").on(
      table.electionId,
      table.startedAt.desc(),
    ),
    check(
      "discovery_runs_method_check",
      sql`${table.method} = 'manual_fixture'`,
    ),
    check(
      "discovery_runs_payload_sha256_check",
      sql`${table.payloadSha256} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const discoveredSources = pgTable(
  "discovered_sources",
  {
    id: text().primaryKey(),
    discoveryRunId: text("discovery_run_id")
      .notNull()
      .references(() => discoveryRuns.id),
    candidacyId: text("candidacy_id")
      .notNull()
      .references(() => candidacies.id),
    observedUrl: text("observed_url").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    proposedTitle: text("proposed_title").notNull(),
    sourceType: text("source_type").notNull(),
    ownershipEvidence: jsonb("ownership_evidence").notNull(),
    observedAt: timestamptz("observed_at").notNull(),
    status: text().notNull(),
    reviewedAt: timestamptz("reviewed_at"),
    reviewerNote: text("reviewer_note"),
    rejectionReason: text("rejection_reason"),
    acceptedSourceId: text("accepted_source_id").references(() => sources.id),
  },
  (table) => [
    unique("discovered_source_identity").on(
      table.discoveryRunId,
      table.candidacyId,
      table.canonicalUrl,
    ),
    index("discovered_sources_candidacy_status_idx").on(
      table.candidacyId,
      table.status,
    ),
    index("discovered_sources_accepted_source_idx")
      .on(table.acceptedSourceId)
      .where(sql`${table.acceptedSourceId} IS NOT NULL`),
    check(
      "discovered_sources_proposed_title_check",
      sql`char_length(${table.proposedTitle}) BETWEEN 1 AND 200`,
    ),
    check(
      "discovered_sources_source_type_check",
      sql`${table.sourceType} = 'website'`,
    ),
    check(
      "discovered_sources_status_check",
      sql`${table.status} IN ('proposed', 'accepted', 'rejected')`,
    ),
    check(
      "discovered_sources_reviewer_note_check",
      sql`${table.reviewerNote} IS NULL OR char_length(${table.reviewerNote}) BETWEEN 1 AND 500`,
    ),
    check(
      "discovered_sources_rejection_reason_check",
      sql`${table.rejectionReason} IS NULL OR ${table.rejectionReason} IN ('ownership-not-established', 'duplicate', 'out-of-scope')`,
    ),
    check(
      "discovered_source_decision_state",
      sql`(
        (${table.status} = 'proposed'
          AND ${table.reviewedAt} IS NULL
          AND ${table.reviewerNote} IS NULL
          AND ${table.rejectionReason} IS NULL
          AND ${table.acceptedSourceId} IS NULL)
        OR
        (${table.status} = 'accepted'
          AND ${table.reviewedAt} IS NOT NULL
          AND ${table.rejectionReason} IS NULL
          AND ${table.acceptedSourceId} IS NOT NULL)
        OR
        (${table.status} = 'rejected'
          AND ${table.reviewedAt} IS NOT NULL
          AND ${table.rejectionReason} IS NOT NULL
          AND ${table.acceptedSourceId} IS NULL)
      )`,
    ),
  ],
);

export const stageRuns = pgTable("stage_runs", {
  id: text().primaryKey(),
  stage: text().notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  attempt: integer().notNull(),
  processorName: text("processor_name").notNull(),
  processorVersion: text("processor_version").notNull(),
  configSha256: text("config_sha256").notNull(),
  inputRefs: jsonb("input_refs").notNull(),
  outputRefs: jsonb("output_refs"),
  status: text().notNull(),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  startedAt: timestamptz("started_at").notNull(),
  completedAt: timestamptz("completed_at"),
});

export const sourceSnapshots = pgTable("source_snapshots", {
  id: text().primaryKey(),
  sourceId: text("source_id")
    .notNull()
    .references(() => sources.id),
  capturedAt: timestamptz("captured_at").notNull(),
  originalUrl: text("original_url").notNull(),
  canonicalUrl: text("canonical_url").notNull(),
  contentType: text("content_type").notNull(),
  encoding: text().notNull(),
  rawContent: bytea("raw_content").notNull(),
  byteLength: integer("byte_length").notNull(),
  contentSha256: text("content_sha256").notNull(),
});

export const captureObservations = pgTable("capture_observations", {
  id: text().primaryKey(),
  sourceId: text("source_id")
    .notNull()
    .references(() => sources.id),
  snapshotId: text("snapshot_id")
    .notNull()
    .references(() => sourceSnapshots.id),
  observedAt: timestamptz("observed_at").notNull(),
  requestedUrl: text("requested_url").notNull(),
});

export const normalizedBlocks = pgTable("normalized_blocks", {
  id: text().primaryKey(),
  snapshotId: text("snapshot_id")
    .notNull()
    .references(() => sourceSnapshots.id),
  ordinal: integer().notNull(),
  blockType: text("block_type").notNull(),
  text: text().notNull(),
  textSha256: text("text_sha256").notNull(),
});

export const extractionRuns = pgTable("extraction_runs", {
  id: text().primaryKey(),
  snapshotId: text("snapshot_id")
    .notNull()
    .references(() => sourceSnapshots.id),
  promptKey: text("prompt_key").notNull(),
  promptSha256: text("prompt_sha256").notNull(),
  model: text().notNull(),
  schemaVersion: text("schema_version").notNull(),
  status: text().notNull(),
  rawResult: jsonb("raw_result").notNull(),
  createdAt: timestamptz("created_at").notNull(),
});

export const statements = pgTable("statements", {
  id: text().primaryKey(),
  extractionRunId: text("extraction_run_id")
    .notNull()
    .references(() => extractionRuns.id),
  extractionItemId: text("extraction_item_id").notNull(),
  candidacyId: text("candidacy_id")
    .notNull()
    .references(() => candidacies.id),
  summary: text().notNull(),
  attributionType: text("attribution_type").notNull(),
  status: text().notNull(),
  approvedAt: timestamptz("approved_at"),
});

export const evidence = pgTable("evidence", {
  id: text().primaryKey(),
  statementId: text("statement_id")
    .notNull()
    .references(() => statements.id),
  normalizedBlockId: text("normalized_block_id")
    .notNull()
    .references(() => normalizedBlocks.id),
  quote: text().notNull(),
  startOffset: integer("start_offset").notNull(),
  endOffset: integer("end_offset").notNull(),
});

export const issues = pgTable("issues", {
  id: text().primaryKey(),
  slug: text().notNull().unique(),
  label: text().notNull(),
});

export const statementIssues = pgTable(
  "statement_issues",
  {
    statementId: text("statement_id")
      .notNull()
      .references(() => statements.id),
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id),
  },
  (table) => [primaryKey({ columns: [table.statementId, table.issueId] })],
);

export const statementEditorialEvents = pgTable(
  "statement_editorial_events",
  {
    id: text().primaryKey(),
    statementId: text("statement_id")
      .notNull()
      .references(() => statements.id),
    eventType: text("event_type").notNull(),
    requestId: text("request_id").notNull(),
    inputFingerprintSha256: text("input_fingerprint_sha256").notNull(),
    sequence: integer().notNull(),
    operatorRef: text("operator_ref").notNull(),
    note: text(),
    reason: text(),
    previousStatus: text("previous_status").notNull(),
    currentStatus: text("current_status").notNull(),
    reviewSubjectSha256: text("review_subject_sha256").notNull(),
    occurredAt: timestamptz("occurred_at").notNull(),
  },
  (table) => [
    unique("statement_editorial_event_sequence").on(
      table.statementId,
      table.sequence,
    ),
    unique("statement_editorial_event_replay").on(
      table.statementId,
      table.eventType,
      table.requestId,
    ),
    index("statement_editorial_events_timeline_idx").on(
      table.statementId,
      table.sequence,
    ),
  ],
);

export const researchRuns = pgTable("research_runs", {
  id: text().primaryKey(),
  candidacyId: text("candidacy_id")
    .notNull()
    .references(() => candidacies.id),
  methodologyVersion: text("methodology_version").notNull(),
  sourceScope: jsonb("source_scope").notNull(),
  status: text().notNull(),
  startedAt: timestamptz("started_at").notNull(),
  completedAt: timestamptz("completed_at"),
});

export const researchRunSources = pgTable("research_run_sources", {
  id: text().primaryKey(),
  researchRunId: text("research_run_id")
    .notNull()
    .references(() => researchRuns.id),
  sourceId: text("source_id").references(() => sources.id),
  attemptedUrl: text("attempted_url").notNull(),
  outcome: text().notNull(),
  snapshotId: text("snapshot_id").references(() => sourceSnapshots.id),
  extractionRunId: text("extraction_run_id").references(
    () => extractionRuns.id,
  ),
  reviewedAt: timestamptz("reviewed_at"),
  errorCode: text("error_code"),
  observedAt: timestamptz("observed_at").notNull(),
  exclusionReason: text("exclusion_reason"),
});

export const publications = pgTable("publications", {
  id: text().primaryKey(),
  statementId: text("statement_id")
    .notNull()
    .unique()
    .references(() => statements.id),
  payload: jsonb().notNull(),
  payloadSha256: text("payload_sha256").notNull(),
  publishedAt: timestamptz("published_at").notNull(),
  withdrawnAt: timestamptz("withdrawn_at"),
  withdrawalReason: text("withdrawal_reason"),
});

export const publicationEvents = pgTable(
  "publication_events",
  {
    id: text().primaryKey(),
    publicationId: text("publication_id")
      .notNull()
      .references(() => publications.id),
    eventType: text("event_type").notNull(),
    requestId: text("request_id").notNull(),
    inputFingerprintSha256: text("input_fingerprint_sha256").notNull(),
    approvedEditorialEventId: text("approved_editorial_event_id").references(
      () => statementEditorialEvents.id,
    ),
    operatorRef: text("operator_ref").notNull(),
    reason: text(),
    occurredAt: timestamptz("occurred_at").notNull(),
  },
  (table) => [
    unique("publication_event_type").on(
      table.publicationId,
      table.eventType,
    ),
    unique("publication_event_replay").on(
      table.publicationId,
      table.eventType,
      table.requestId,
    ),
    index("publication_events_timeline_idx").on(
      table.publicationId,
      table.occurredAt,
    ),
  ],
);

export const statementEmbeddings = pgTable("statement_embeddings", {
  id: text().primaryKey(),
  statementId: text("statement_id")
    .notNull()
    .references(() => statements.id),
  model: text().notNull(),
  dimensions: integer().notNull(),
  embedding: vector1536(),
  createdAt: timestamptz("created_at").notNull(),
});
