ALTER TABLE candidacies
  ADD COLUMN official_person_key text;

CREATE INDEX candidacy_status_upstream_lookup_idx
  ON candidacy_status_history(upstream_key, candidacy_id, observed_at DESC);
