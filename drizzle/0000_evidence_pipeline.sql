CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE municipalities (
  id text PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  name text NOT NULL
);

CREATE TABLE elections (
  id text PRIMARY KEY,
  municipality_id text NOT NULL REFERENCES municipalities(id),
  name text NOT NULL,
  election_date date NOT NULL
);

CREATE TABLE offices (
  id text PRIMARY KEY,
  election_id text NOT NULL REFERENCES elections(id),
  office_type text NOT NULL,
  name text NOT NULL,
  ward_slug text
);

CREATE TABLE people (
  id text PRIMARY KEY,
  display_name text NOT NULL
);

CREATE TABLE candidacies (
  id text PRIMARY KEY,
  election_id text NOT NULL REFERENCES elections(id),
  office_id text NOT NULL REFERENCES offices(id),
  person_id text NOT NULL REFERENCES people(id),
  slug text NOT NULL,
  status text NOT NULL CHECK (status IN ('registered', 'withdrawn', 'elected', 'not_elected')),
  UNIQUE (election_id, office_id, person_id),
  UNIQUE (election_id, slug)
);

CREATE TABLE candidacy_status_history (
  id text PRIMARY KEY,
  candidacy_id text NOT NULL REFERENCES candidacies(id),
  status text NOT NULL CHECK (status IN ('registered', 'withdrawn', 'elected', 'not_elected')),
  observed_at timestamptz NOT NULL,
  upstream_key text NOT NULL,
  UNIQUE (candidacy_id, status, observed_at)
);

CREATE TABLE sources (
  id text PRIMARY KEY,
  candidacy_id text NOT NULL REFERENCES candidacies(id),
  source_type text NOT NULL CHECK (source_type IN ('official_import', 'website', 'facebook', 'instagram', 'youtube', 'news', 'pdf', 'manual')),
  title text NOT NULL,
  canonical_url text NOT NULL,
  attribution_policy text NOT NULL CHECK (attribution_policy IN ('candidate_owned', 'official_campaign', 'third_party')),
  active boolean NOT NULL,
  UNIQUE (candidacy_id, canonical_url)
);

CREATE TABLE stage_runs (
  id text PRIMARY KEY,
  stage text NOT NULL,
  idempotency_key text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  processor_name text NOT NULL,
  processor_version text NOT NULL,
  config_sha256 text NOT NULL,
  input_refs jsonb NOT NULL,
  output_refs jsonb,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  error_code text,
  error_message text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (stage, idempotency_key, attempt)
);

CREATE UNIQUE INDEX stage_runs_one_success
  ON stage_runs(stage, idempotency_key)
  WHERE status = 'succeeded';

CREATE TABLE source_snapshots (
  id text PRIMARY KEY,
  source_id text NOT NULL REFERENCES sources(id),
  captured_at timestamptz NOT NULL,
  original_url text NOT NULL,
  canonical_url text NOT NULL,
  content_type text NOT NULL,
  encoding text NOT NULL,
  raw_content bytea NOT NULL,
  byte_length integer NOT NULL CHECK (byte_length >= 0),
  content_sha256 text NOT NULL,
  UNIQUE (source_id, content_sha256),
  UNIQUE (id, source_id)
);

CREATE TABLE capture_observations (
  id text PRIMARY KEY,
  source_id text NOT NULL REFERENCES sources(id),
  snapshot_id text NOT NULL REFERENCES source_snapshots(id),
  observed_at timestamptz NOT NULL,
  requested_url text NOT NULL,
  UNIQUE (source_id, observed_at)
);

CREATE TABLE normalized_blocks (
  id text PRIMARY KEY,
  snapshot_id text NOT NULL REFERENCES source_snapshots(id),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  block_type text NOT NULL,
  text text NOT NULL,
  text_sha256 text NOT NULL,
  UNIQUE (snapshot_id, ordinal)
);

CREATE TABLE extraction_runs (
  id text PRIMARY KEY,
  snapshot_id text NOT NULL REFERENCES source_snapshots(id),
  prompt_key text NOT NULL,
  prompt_sha256 text NOT NULL,
  model text NOT NULL,
  schema_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  raw_result jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (snapshot_id, prompt_sha256, model, schema_version)
);

CREATE TABLE statements (
  id text PRIMARY KEY,
  extraction_run_id text NOT NULL REFERENCES extraction_runs(id),
  extraction_item_id text NOT NULL,
  candidacy_id text NOT NULL REFERENCES candidacies(id),
  summary text NOT NULL,
  attribution_type text NOT NULL CHECK (attribution_type IN ('candidate', 'campaign')),
  status text NOT NULL CHECK (status IN ('draft', 'approved', 'rejected')),
  approved_at timestamptz,
  UNIQUE (extraction_run_id, extraction_item_id)
);

CREATE TABLE evidence (
  id text PRIMARY KEY,
  statement_id text NOT NULL REFERENCES statements(id),
  normalized_block_id text NOT NULL REFERENCES normalized_blocks(id),
  quote text NOT NULL,
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_offset integer NOT NULL CHECK (end_offset >= start_offset),
  UNIQUE (statement_id, normalized_block_id, start_offset, end_offset)
);

CREATE TABLE issues (
  id text PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  label text NOT NULL
);

CREATE TABLE statement_issues (
  statement_id text NOT NULL REFERENCES statements(id),
  issue_id text NOT NULL REFERENCES issues(id),
  PRIMARY KEY (statement_id, issue_id)
);

CREATE TABLE research_runs (
  id text PRIMARY KEY,
  candidacy_id text NOT NULL REFERENCES candidacies(id),
  methodology_version text NOT NULL,
  source_scope jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE TABLE research_run_sources (
  id text PRIMARY KEY,
  research_run_id text NOT NULL REFERENCES research_runs(id),
  source_id text REFERENCES sources(id),
  attempted_url text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('captured', 'failed', 'excluded')),
  snapshot_id text,
  extraction_run_id text REFERENCES extraction_runs(id),
  reviewed_at timestamptz,
  error_code text,
  observed_at timestamptz NOT NULL,
  exclusion_reason text,
  UNIQUE (research_run_id, attempted_url),
  FOREIGN KEY (snapshot_id, source_id) REFERENCES source_snapshots(id, source_id)
);

CREATE TABLE publications (
  id text PRIMARY KEY,
  statement_id text UNIQUE NOT NULL REFERENCES statements(id),
  payload jsonb NOT NULL,
  payload_sha256 text NOT NULL,
  published_at timestamptz NOT NULL,
  withdrawn_at timestamptz,
  withdrawal_reason text
);

CREATE TABLE statement_embeddings (
  id text PRIMARY KEY,
  statement_id text NOT NULL REFERENCES statements(id),
  model text NOT NULL,
  dimensions integer NOT NULL,
  embedding vector(1536),
  created_at timestamptz NOT NULL,
  UNIQUE (statement_id, model)
);

CREATE INDEX sources_candidacy_active_idx ON sources(candidacy_id, active);
CREATE INDEX snapshots_source_captured_idx ON source_snapshots(source_id, captured_at DESC);
CREATE INDEX observations_source_observed_idx ON capture_observations(source_id, observed_at DESC);
CREATE INDEX research_candidacy_completed_idx ON research_runs(candidacy_id, completed_at DESC);
CREATE INDEX statements_candidacy_status_idx ON statements(candidacy_id, status);
CREATE INDEX publications_active_idx ON publications(withdrawn_at, published_at DESC);
