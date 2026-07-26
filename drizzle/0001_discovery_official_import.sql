CREATE TABLE official_import_runs (
  id text PRIMARY KEY,
  election_id text NOT NULL REFERENCES elections(id),
  source_url text NOT NULL,
  observed_at timestamptz NOT NULL,
  content_type text NOT NULL CHECK (content_type = 'application/json'),
  encoding text NOT NULL CHECK (encoding = 'utf-8'),
  raw_payload bytea NOT NULL,
  byte_length integer NOT NULL CHECK (byte_length > 0),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  imported_count integer NOT NULL CHECK (imported_count > 0),
  UNIQUE (election_id, source_url, observed_at)
);

ALTER TABLE candidacy_status_history
  ADD COLUMN official_import_run_id text REFERENCES official_import_runs(id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM candidacy_status_history
     GROUP BY candidacy_id, observed_at
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot apply 0001: candidacy status history has conflicting equal-time observations.'
      USING ERRCODE = '23505';
  END IF;
END
$$;

CREATE UNIQUE INDEX candidacy_status_observed_unique
  ON candidacy_status_history(candidacy_id, observed_at);

CREATE TABLE discovery_runs (
  id text PRIMARY KEY,
  election_id text NOT NULL REFERENCES elections(id),
  method text NOT NULL CHECK (method = 'manual_fixture'),
  method_version text NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  UNIQUE (election_id, method, method_version, payload_sha256, started_at)
);

CREATE TABLE discovered_sources (
  id text PRIMARY KEY,
  discovery_run_id text NOT NULL REFERENCES discovery_runs(id),
  candidacy_id text NOT NULL REFERENCES candidacies(id),
  observed_url text NOT NULL,
  canonical_url text NOT NULL,
  proposed_title text NOT NULL CHECK (
    char_length(proposed_title) BETWEEN 1 AND 200
  ),
  source_type text NOT NULL CHECK (source_type = 'website'),
  ownership_evidence jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected')),
  reviewed_at timestamptz,
  reviewer_note text CHECK (
    reviewer_note IS NULL OR char_length(reviewer_note) BETWEEN 1 AND 500
  ),
  rejection_reason text CHECK (
    rejection_reason IS NULL OR rejection_reason IN (
      'ownership-not-established',
      'duplicate',
      'out-of-scope'
    )
  ),
  accepted_source_id text REFERENCES sources(id),
  UNIQUE (discovery_run_id, candidacy_id, canonical_url),
  CHECK (
    (
      status = 'proposed'
      AND reviewed_at IS NULL
      AND reviewer_note IS NULL
      AND rejection_reason IS NULL
      AND accepted_source_id IS NULL
    )
    OR (
      status = 'accepted'
      AND reviewed_at IS NOT NULL
      AND rejection_reason IS NULL
      AND accepted_source_id IS NOT NULL
    )
    OR (
      status = 'rejected'
      AND reviewed_at IS NOT NULL
      AND rejection_reason IS NOT NULL
      AND accepted_source_id IS NULL
    )
  )
);

CREATE INDEX official_import_runs_election_observed_idx
  ON official_import_runs(election_id, observed_at DESC);
CREATE INDEX discovery_runs_election_started_idx
  ON discovery_runs(election_id, started_at DESC);
CREATE INDEX discovered_sources_candidacy_status_idx
  ON discovered_sources(candidacy_id, status);
CREATE INDEX discovered_sources_accepted_source_idx
  ON discovered_sources(accepted_source_id)
  WHERE accepted_source_id IS NOT NULL;
