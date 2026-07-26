import {
  boolean,
  customType,
  date,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

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
  },
);

export const sources = pgTable("sources", {
  id: text().primaryKey(),
  candidacyId: text("candidacy_id")
    .notNull()
    .references(() => candidacies.id),
  sourceType: text("source_type").notNull(),
  title: text().notNull(),
  canonicalUrl: text("canonical_url").notNull(),
  attributionPolicy: text("attribution_policy").notNull(),
  active: boolean().notNull(),
});

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
