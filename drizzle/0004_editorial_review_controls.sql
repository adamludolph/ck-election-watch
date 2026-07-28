DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM statements st
     WHERE st.status = 'approved'
       AND NOT EXISTS (
         SELECT 1 FROM publications p WHERE p.statement_id = st.id
       )
  ) THEN
    RAISE EXCEPTION 'Milestone 2 approved statement has no publication.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM publications p
      JOIN statements st ON st.id = p.statement_id
     WHERE st.status <> 'approved' OR st.approved_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Milestone 2 publication is not backed by an approved statement.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM publications p
      JOIN statements st ON st.id = p.statement_id
     WHERE st.approved_at > p.published_at
  ) THEN
    RAISE EXCEPTION 'Milestone 2 approval postdates publication.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM publications
     WHERE withdrawn_at IS NOT NULL
       AND withdrawn_at < published_at
  ) THEN
    RAISE EXCEPTION 'Milestone 2 withdrawal predates publication.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM publications
     WHERE withdrawn_at IS NULL
       AND withdrawal_reason IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Milestone 2 open publication has a withdrawal reason.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM publications
     WHERE withdrawn_at IS NOT NULL
       AND NULLIF(btrim(withdrawal_reason), '') IS NOT NULL
       AND char_length(btrim(withdrawal_reason)) > 500
  ) THEN
    RAISE EXCEPTION 'Milestone 2 withdrawal reason exceeds 500 characters.';
  END IF;
END
$$;

ALTER TABLE statements DROP CONSTRAINT statements_status_check;
ALTER TABLE statements
  ADD CONSTRAINT statements_status_check
  CHECK (status IN ('draft', 'approved', 'rejected', 'withdrawn'));

CREATE TABLE statement_editorial_events (
  id text PRIMARY KEY,
  statement_id text NOT NULL REFERENCES statements(id),
  event_type text NOT NULL CHECK (
    event_type IN (
      'reviewed_ready',
      'reviewed_changes_requested',
      'approved',
      'rejected',
      'withdrawn'
    )
  ),
  request_id text NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 200),
  input_fingerprint_sha256 text NOT NULL CHECK (
    input_fingerprint_sha256 ~ '^[a-f0-9]{64}$'
  ),
  sequence integer NOT NULL CHECK (sequence > 0),
  operator_ref text NOT NULL CHECK (char_length(operator_ref) BETWEEN 1 AND 100),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
  reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500),
  previous_status text NOT NULL CHECK (
    previous_status IN ('draft', 'approved', 'rejected', 'withdrawn')
  ),
  current_status text NOT NULL CHECK (
    current_status IN ('draft', 'approved', 'rejected', 'withdrawn')
  ),
  review_subject_sha256 text NOT NULL CHECK (
    review_subject_sha256 ~ '^[a-f0-9]{64}$'
  ),
  occurred_at timestamptz NOT NULL,
  UNIQUE (statement_id, sequence),
  UNIQUE (statement_id, event_type, request_id),
  CHECK (
    (
      event_type = 'reviewed_ready'
      AND previous_status = 'draft'
      AND current_status = 'draft'
      AND reason IS NULL
    )
    OR (
      event_type = 'reviewed_changes_requested'
      AND previous_status = 'draft'
      AND current_status = 'draft'
      AND note IS NULL
      AND reason IS NOT NULL
    )
    OR (
      event_type = 'approved'
      AND previous_status = 'draft'
      AND current_status = 'approved'
      AND note IS NULL
      AND reason IS NOT NULL
    )
    OR (
      event_type = 'rejected'
      AND previous_status = 'draft'
      AND current_status = 'rejected'
      AND note IS NULL
      AND reason IS NOT NULL
    )
    OR (
      event_type = 'withdrawn'
      AND previous_status = 'approved'
      AND current_status = 'withdrawn'
      AND note IS NULL
      AND reason IS NOT NULL
    )
  )
);

CREATE TABLE publication_events (
  id text PRIMARY KEY,
  publication_id text NOT NULL REFERENCES publications(id),
  event_type text NOT NULL CHECK (
    event_type IN ('published', 'unpublished')
  ),
  request_id text NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 200),
  input_fingerprint_sha256 text NOT NULL CHECK (
    input_fingerprint_sha256 ~ '^[a-f0-9]{64}$'
  ),
  approved_editorial_event_id text REFERENCES statement_editorial_events(id),
  operator_ref text NOT NULL CHECK (char_length(operator_ref) BETWEEN 1 AND 100),
  reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500),
  occurred_at timestamptz NOT NULL,
  UNIQUE (publication_id, event_type),
  UNIQUE (publication_id, event_type, request_id),
  CHECK (
    (
      event_type = 'published'
      AND approved_editorial_event_id IS NOT NULL
    )
    OR (
      event_type = 'unpublished'
      AND approved_editorial_event_id IS NULL
      AND reason IS NOT NULL
    )
  )
);

CREATE INDEX statement_editorial_events_timeline_idx
  ON statement_editorial_events(statement_id, sequence);

CREATE INDEX publication_events_timeline_idx
  ON publication_events(publication_id, occurred_at);

INSERT INTO statement_editorial_events (
  id,
  statement_id,
  event_type,
  request_id,
  input_fingerprint_sha256,
  sequence,
  operator_ref,
  reason,
  previous_status,
  current_status,
  review_subject_sha256,
  occurred_at
)
SELECT
  'migration-editorial-approved-' || p.statement_id,
  p.statement_id,
  'approved',
  'migration:editorial:' || p.statement_id || ':approved',
  p.payload_sha256,
  1,
  'migration:milestone-2',
  'Migrated approved Milestone 2 publication.',
  'draft',
  'approved',
  p.payload_sha256,
  st.approved_at
FROM publications p
JOIN statements st ON st.id = p.statement_id;

INSERT INTO publication_events (
  id,
  publication_id,
  event_type,
  request_id,
  input_fingerprint_sha256,
  approved_editorial_event_id,
  operator_ref,
  occurred_at
)
SELECT
  'migration-publication-published-' || p.id,
  p.id,
  'published',
  'migration:publication:' || p.id || ':published',
  p.payload_sha256,
  'migration-editorial-approved-' || p.statement_id,
  'migration:milestone-2',
  p.published_at
FROM publications p;

INSERT INTO publication_events (
  id,
  publication_id,
  event_type,
  request_id,
  input_fingerprint_sha256,
  operator_ref,
  reason,
  occurred_at
)
SELECT
  'migration-publication-unpublished-' || p.id,
  p.id,
  'unpublished',
  'migration:publication:' || p.id || ':unpublished',
  p.payload_sha256,
  'migration:milestone-2',
  COALESCE(
    NULLIF(btrim(p.withdrawal_reason), ''),
    'Migrated legacy withdrawal without recorded reason.'
  ),
  p.withdrawn_at
FROM publications p
WHERE p.withdrawn_at IS NOT NULL;

INSERT INTO statement_editorial_events (
  id,
  statement_id,
  event_type,
  request_id,
  input_fingerprint_sha256,
  sequence,
  operator_ref,
  reason,
  previous_status,
  current_status,
  review_subject_sha256,
  occurred_at
)
SELECT
  'migration-editorial-withdrawn-' || p.statement_id,
  p.statement_id,
  'withdrawn',
  'migration:editorial:' || p.statement_id || ':withdrawn',
  p.payload_sha256,
  2,
  'migration:milestone-2',
  COALESCE(
    NULLIF(btrim(p.withdrawal_reason), ''),
    'Migrated legacy withdrawal without recorded reason.'
  ),
  'approved',
  'withdrawn',
  p.payload_sha256,
  p.withdrawn_at
FROM publications p
WHERE p.withdrawn_at IS NOT NULL;

UPDATE statements st
   SET status = 'withdrawn'
  FROM publications p
 WHERE p.statement_id = st.id
   AND p.withdrawn_at IS NOT NULL;

CREATE VIEW active_publication_payloads AS
SELECT
  p.id AS publication_id,
  p.statement_id,
  p.payload ->> 'candidacySlug' AS candidacy_slug,
  p.payload,
  p.payload_sha256,
  published.occurred_at AS published_at
FROM publications p
JOIN publication_events published
  ON published.publication_id = p.id
 AND published.event_type = 'published'
JOIN statement_editorial_events approved
  ON approved.id = published.approved_editorial_event_id
 AND approved.statement_id = p.statement_id
 AND approved.event_type = 'approved'
WHERE NOT EXISTS (
  SELECT 1
    FROM publication_events unpublished
   WHERE unpublished.publication_id = p.id
     AND unpublished.event_type = 'unpublished'
);

CREATE FUNCTION protect_publication_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'publication snapshot is immutable';
  END IF;
  IF NEW.statement_id IS DISTINCT FROM OLD.statement_id
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
     OR NEW.published_at IS DISTINCT FROM OLD.published_at
  THEN
    RAISE EXCEPTION 'publication snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER publications_snapshot_immutable
BEFORE UPDATE OR DELETE ON publications
FOR EACH ROW EXECUTE FUNCTION protect_publication_snapshot();

CREATE FUNCTION reject_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER statement_editorial_events_append_only
BEFORE UPDATE OR DELETE ON statement_editorial_events
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TRIGGER publication_events_append_only
BEFORE UPDATE OR DELETE ON publication_events
FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
