import type { PGlite } from "@electric-sql/pglite";
import { z } from "zod";
import { CandidateImportValidationError } from "@/lib/core/errors";
import { stableId } from "@/lib/core/hash";
import { runStage } from "@/lib/pipeline/stage";

export const candidateFixtureSchema = z.object({
  municipality: z.object({
    id: z.string().min(1),
    slug: z.string().min(1),
    name: z.string().min(1),
  }),
  election: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    electionDate: z.iso.date(),
  }),
  office: z.object({
    id: z.string().min(1),
    officeType: z.string().min(1),
    name: z.string().min(1),
    wardSlug: z.string().nullable(),
  }),
  person: z.object({
    id: z.string().min(1),
    displayName: z.string().min(1),
  }),
  candidacy: z.object({
    id: z.string().min(1),
    slug: z.string().min(1),
    status: z.enum(["registered", "withdrawn", "elected", "not_elected"]),
    upstreamKey: z.string().min(1),
  }),
  observedAt: z.iso.datetime(),
});

export type CandidateFixture = z.infer<typeof candidateFixtureSchema>;

export async function importCandidateFixture(
  db: PGlite,
  rawFixture: unknown,
): Promise<{ candidacyId: string; candidacySlug: string }> {
  const parsed = candidateFixtureSchema.safeParse(rawFixture);
  if (!parsed.success) {
    throw new CandidateImportValidationError(
      "Candidate fixture is invalid.",
      parsed.error,
    );
  }
  const fixture = parsed.data;
  return runStage(
    db,
    {
      stage: "candidate-import",
      idempotencyKey: stableId(
        "candidate-import",
        fixture.candidacy.upstreamKey,
        fixture.candidacy.status,
        fixture.observedAt,
      ),
      processorName: "official-fixture-import",
      processorVersion: "1",
      inputRefs: { upstreamKey: fixture.candidacy.upstreamKey },
      now: fixture.observedAt,
    },
    async () => {
      await db.query(
        `INSERT INTO municipalities (id, slug, name)
         VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
        [
          fixture.municipality.id,
          fixture.municipality.slug,
          fixture.municipality.name,
        ],
      );
      await db.query(
        `INSERT INTO elections (id, municipality_id, name, election_date)
         VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [
          fixture.election.id,
          fixture.municipality.id,
          fixture.election.name,
          fixture.election.electionDate,
        ],
      );
      await db.query(
        `INSERT INTO offices (id, election_id, office_type, name, ward_slug)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
        [
          fixture.office.id,
          fixture.election.id,
          fixture.office.officeType,
          fixture.office.name,
          fixture.office.wardSlug,
        ],
      );
      await db.query(
        `INSERT INTO people (id, display_name)
         VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
        [fixture.person.id, fixture.person.displayName],
      );
      await db.query(
        `INSERT INTO candidacies (
           id, election_id, office_id, person_id, slug, status
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [
          fixture.candidacy.id,
          fixture.election.id,
          fixture.office.id,
          fixture.person.id,
          fixture.candidacy.slug,
          fixture.candidacy.status,
        ],
      );
      const historyId = stableId(
        "status",
        fixture.candidacy.id,
        fixture.candidacy.status,
        fixture.observedAt,
      );
      await db.query(
        `INSERT INTO candidacy_status_history (
           id, candidacy_id, status, observed_at, upstream_key
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (candidacy_id, status, observed_at) DO NOTHING`,
        [
          historyId,
          fixture.candidacy.id,
          fixture.candidacy.status,
          fixture.observedAt,
          fixture.candidacy.upstreamKey,
        ],
      );
      await db.query(
        `UPDATE candidacies
            SET status = (
              SELECT status
                FROM candidacy_status_history
               WHERE candidacy_id = $1
               ORDER BY observed_at DESC, id DESC
               LIMIT 1
            )
          WHERE id = $1`,
        [fixture.candidacy.id],
      );
      return {
        candidacyId: fixture.candidacy.id,
        candidacySlug: fixture.candidacy.slug,
      };
    },
  );
}
