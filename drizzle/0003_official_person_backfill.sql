DO $$
BEGIN
  IF EXISTS (
    WITH imported_person_keys AS (
      SELECT c.id AS candidacy_id,
             candidate.value ->> 'upstreamPersonKey' AS official_person_key
        FROM candidacies c
        JOIN candidacy_status_history h ON h.candidacy_id = c.id
        JOIN official_import_runs ir ON ir.id = h.official_import_run_id
        CROSS JOIN LATERAL jsonb_array_elements(
          convert_from(ir.raw_payload, 'UTF8')::jsonb -> 'candidates'
        ) AS candidate(value)
       WHERE candidate.value ->> 'upstreamKey' = h.upstream_key
    )
    SELECT 1
      FROM imported_person_keys
     GROUP BY candidacy_id
    HAVING COUNT(DISTINCT official_person_key) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot apply 0003: one candidacy maps to multiple official person keys.'
      USING ERRCODE = '23505';
  END IF;

  IF EXISTS (
    WITH imported_person_keys AS (
      SELECT e.municipality_id,
             c.person_id,
             candidate.value ->> 'upstreamPersonKey' AS official_person_key
        FROM candidacies c
        JOIN elections e ON e.id = c.election_id
        JOIN candidacy_status_history h ON h.candidacy_id = c.id
        JOIN official_import_runs ir ON ir.id = h.official_import_run_id
        CROSS JOIN LATERAL jsonb_array_elements(
          convert_from(ir.raw_payload, 'UTF8')::jsonb -> 'candidates'
        ) AS candidate(value)
       WHERE candidate.value ->> 'upstreamKey' = h.upstream_key
    )
    SELECT 1
      FROM imported_person_keys
     GROUP BY municipality_id, official_person_key
    HAVING COUNT(DISTINCT person_id) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot apply 0003: one official person key maps to multiple people.'
      USING ERRCODE = '23505';
  END IF;
END
$$;

WITH imported_person_keys AS (
  SELECT c.id AS candidacy_id,
         MIN(candidate.value ->> 'upstreamPersonKey') AS official_person_key
    FROM candidacies c
    JOIN candidacy_status_history h ON h.candidacy_id = c.id
    JOIN official_import_runs ir ON ir.id = h.official_import_run_id
    CROSS JOIN LATERAL jsonb_array_elements(
      convert_from(ir.raw_payload, 'UTF8')::jsonb -> 'candidates'
    ) AS candidate(value)
   WHERE candidate.value ->> 'upstreamKey' = h.upstream_key
   GROUP BY c.id
)
UPDATE candidacies c
   SET official_person_key = imported_person_keys.official_person_key
  FROM imported_person_keys
 WHERE c.id = imported_person_keys.candidacy_id
   AND c.official_person_key IS NULL;
