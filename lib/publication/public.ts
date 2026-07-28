import type { PGlite } from "@electric-sql/pglite";
import { publicAbsenceMessage } from "@/lib/publication/absence";
import {
  verifyPublicationPayload,
  type PublishedStatementPayloadV1,
} from "@/lib/publication/payload";

export type PublicIssueRecord = {
  slug: string;
  label: string;
  statements: PublishedStatementPayloadV1[];
  absenceMessage: string | null;
};

export type PublicCandidateRecord = {
  candidacySlug: string;
  candidacyStatus: "registered" | "withdrawn" | "elected" | "not_elected";
  candidateName: string;
  municipalityName: string;
  electionName: string;
  officeName: string;
  coverageComplete: boolean;
  reviewedSourceCount: number;
  sources: Array<{ title: string; url: string }>;
  issues: PublicIssueRecord[];
};

type CandidateRow = {
  candidacy_slug: string;
  candidacy_status: PublicCandidateRecord["candidacyStatus"];
  candidate_name: string;
  municipality_name: string;
  election_name: string;
  office_name: string;
  candidacy_id: string;
};

export async function getPublicCandidateRecord(
  db: PGlite,
  candidacySlug: string,
): Promise<PublicCandidateRecord | null> {
  const candidate = await db.query<CandidateRow>(
    `SELECT
       c.slug AS candidacy_slug,
       c.status AS candidacy_status,
       c.id AS candidacy_id,
       p.display_name AS candidate_name,
       m.name AS municipality_name,
       e.name AS election_name,
       o.name AS office_name
     FROM candidacies c
     JOIN people p ON p.id = c.person_id
     JOIN elections e ON e.id = c.election_id
     JOIN municipalities m ON m.id = e.municipality_id
     JOIN offices o ON o.id = c.office_id
     WHERE c.slug = $1`,
    [candidacySlug],
  );
  const row = candidate.rows[0];
  if (!row) {
    return null;
  }

  const coverage = await db.query<{
    complete: boolean;
    reviewed_source_count: number;
  }>(
    `SELECT
       EXISTS (
         SELECT 1
         FROM research_runs rr
         WHERE rr.candidacy_id = $1
           AND rr.status = 'completed'
           AND rr.completed_at IS NOT NULL
           AND jsonb_array_length(rr.source_scope) = (
             SELECT COUNT(*)::integer
             FROM research_run_sources rrs
             WHERE rrs.research_run_id = rr.id
           )
           AND NOT EXISTS (
             SELECT 1
             FROM research_run_sources rrs
             WHERE rrs.research_run_id = rr.id
               AND (
                 rrs.outcome <> 'captured'
                 OR rrs.snapshot_id IS NULL
                 OR rrs.extraction_run_id IS NULL
                 OR rrs.reviewed_at IS NULL
               )
           )
       ) AS complete,
       (
         SELECT COUNT(*)::integer
         FROM research_run_sources rrs
         JOIN research_runs rr ON rr.id = rrs.research_run_id
         WHERE rr.candidacy_id = $1
           AND rr.status = 'completed'
           AND rrs.outcome = 'captured'
           AND rrs.reviewed_at IS NOT NULL
       ) AS reviewed_source_count`,
    [row.candidacy_id],
  );
  const coverageComplete = coverage.rows[0]?.complete ?? false;
  const reviewedSourceCount = Number(
    coverage.rows[0]?.reviewed_source_count ?? 0,
  );

  const sourceRows = await db.query<{ title: string; url: string }>(
    `SELECT DISTINCT src.title, src.canonical_url AS url
       FROM sources src
       JOIN research_run_sources rrs ON rrs.source_id = src.id
       JOIN research_runs rr ON rr.id = rrs.research_run_id
      WHERE rr.candidacy_id = $1
        AND rr.status = 'completed'
        AND rrs.outcome = 'captured'
      ORDER BY src.title`,
    [row.candidacy_id],
  );

  const publicationRows = await db.query<{
    payload: string;
    payload_sha256: string;
  }>(
    `SELECT payload::text AS payload, payload_sha256
       FROM active_publication_payloads
      WHERE candidacy_slug = $1
      ORDER BY published_at`,
    [candidacySlug],
  );
  const publications = publicationRows.rows
    .map((publication) =>
      verifyPublicationPayload(
        JSON.parse(publication.payload),
        publication.payload_sha256,
      ),
    );

  const issueRows = await db.query<{ slug: string; label: string }>(
    "SELECT slug, label FROM issues ORDER BY label",
  );
  const issues = issueRows.rows.map((issue) => {
    const statements = publications.filter((publication) =>
      publication.issues.some(
        (publicationIssue) => publicationIssue.slug === issue.slug,
      ),
    );
    return {
      ...issue,
      statements,
      absenceMessage: publicAbsenceMessage({
        coverageComplete,
        hasActivePublication: statements.length > 0,
      }),
    };
  });

  return {
    candidacySlug: row.candidacy_slug,
    candidacyStatus: row.candidacy_status,
    candidateName: row.candidate_name,
    municipalityName: row.municipality_name,
    electionName: row.election_name,
    officeName: row.office_name,
    coverageComplete,
    reviewedSourceCount,
    sources: sourceRows.rows,
    issues,
  };
}
