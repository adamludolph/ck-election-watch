import type { PGlite, Transaction } from "@electric-sql/pglite";
import { z } from "zod";
import {
  OfficialImportConflictError,
  OfficialImportValidationError,
} from "@/lib/core/errors";
import { sha256, stableId } from "@/lib/core/hash";
import { canonicalPublicWebUrl } from "@/lib/core/url";
import { runStage } from "@/lib/pipeline/stage";

const slugSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const keySchema = z.string().trim().min(1).max(128);
const nameSchema = z.string().trim().min(1).max(200);

export const officialRosterFixtureSchema = z
  .object({
    schemaVersion: z.literal("1"),
    source: z
      .object({
        url: z.url(),
        observedAt: z.iso.datetime(),
        contentType: z.literal("application/json"),
        encoding: z.literal("utf-8"),
      })
      .strict(),
    municipality: z
      .object({
        slug: slugSchema,
        name: nameSchema,
      })
      .strict(),
    election: z
      .object({
        name: nameSchema,
        electionDate: z.iso.date(),
      })
      .strict(),
    offices: z
      .array(
        z
          .object({
            key: keySchema,
            officeType: slugSchema,
            name: nameSchema,
            wardSlug: slugSchema.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    candidates: z
      .array(
        z
          .object({
            upstreamKey: keySchema,
            upstreamPersonKey: keySchema,
            displayName: nameSchema,
            slug: slugSchema,
            status: z.enum([
              "registered",
              "withdrawn",
              "elected",
              "not_elected",
            ]),
            officeKey: keySchema,
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();

export type OfficialRosterFixture = z.infer<
  typeof officialRosterFixtureSchema
>;

type DerivedOffice = OfficialRosterFixture["offices"][number] & { id: string };
type DerivedCandidate = OfficialRosterFixture["candidates"][number] & {
  candidacyId: string;
  personId: string;
  officeId: string;
};

export type OfficialImportResult = {
  officialImportRunId: string;
  electionId: string;
  candidacyIds: string[];
};

function decodeFixture(bytes: Uint8Array): OfficialRosterFixture {
  if (bytes.byteLength === 0 || bytes.byteLength > 262_144) {
    throw new OfficialImportValidationError(
      "Official roster fixture must contain 1–262144 bytes.",
    );
  }

  let raw: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    raw = JSON.parse(text);
  } catch (error) {
    throw new OfficialImportValidationError(
      "Official roster fixture must be valid UTF-8 JSON.",
      error,
    );
  }

  const parsed = officialRosterFixtureSchema.safeParse(raw);
  if (!parsed.success) {
    throw new OfficialImportValidationError(
      "Official roster fixture does not match schema version 1.",
      parsed.error,
    );
  }

  const fixture = parsed.data;
  try {
    canonicalPublicWebUrl(fixture.source.url);
  } catch (error) {
    throw new OfficialImportValidationError(
      "Official roster source must be a canonical public HTTP(S) URL.",
      error,
    );
  }
  const officeKeys = new Set<string>();
  for (const office of fixture.offices) {
    if (officeKeys.has(office.key)) {
      throw new OfficialImportValidationError(
        "Official roster fixture contains a duplicate office key.",
      );
    }
    officeKeys.add(office.key);
  }

  const upstreamKeys = new Set<string>();
  const candidacySlugs = new Set<string>();
  const people = new Map<string, string>();
  for (const candidate of fixture.candidates) {
    if (!officeKeys.has(candidate.officeKey)) {
      throw new OfficialImportValidationError(
        "Official roster fixture references an unknown office key.",
      );
    }
    if (upstreamKeys.has(candidate.upstreamKey)) {
      throw new OfficialImportValidationError(
        "Official roster fixture contains a duplicate candidacy upstream key.",
      );
    }
    upstreamKeys.add(candidate.upstreamKey);
    if (candidacySlugs.has(candidate.slug)) {
      throw new OfficialImportValidationError(
        "Official roster fixture contains a duplicate candidacy slug.",
      );
    }
    candidacySlugs.add(candidate.slug);
    const existingName = people.get(candidate.upstreamPersonKey);
    if (existingName && existingName !== candidate.displayName) {
      throw new OfficialImportValidationError(
        "One person upstream key resolves to conflicting display names.",
      );
    }
    people.set(candidate.upstreamPersonKey, candidate.displayName);
  }

  return fixture;
}

function assertFields(
  label: string,
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): void {
  if (
    Object.entries(expected).some(([key, value]) => actual[key] !== value)
  ) {
    throw new OfficialImportConflictError(
      `${label} identity conflicts with existing immutable fields.`,
    );
  }
}

async function reconcileMunicipality(
  tx: Transaction,
  id: string,
  slug: string,
  name: string,
): Promise<string> {
  const existing = await tx.query<{ id: string; slug: string; name: string }>(
    `SELECT id, slug, name
       FROM municipalities
      WHERE id = $1 OR slug = $2`,
    [id, slug],
  );
  if (existing.rows.length > 1) {
    throw new OfficialImportConflictError(
      "Municipality deterministic and natural keys resolve to different rows.",
    );
  }
  if (existing.rows[0]) {
    assertFields("Municipality", existing.rows[0], { slug, name });
    return existing.rows[0].id;
  }
  await tx.query(
    "INSERT INTO municipalities (id, slug, name) VALUES ($1, $2, $3)",
    [id, slug, name],
  );
  return id;
}

async function reconcileElection(
  tx: Transaction,
  id: string,
  municipalityId: string,
  name: string,
  electionDate: string,
): Promise<string> {
  const existing = await tx.query<{
    id: string;
    municipality_id: string;
    name: string;
    election_date: string;
  }>(
    `SELECT id, municipality_id, name, election_date::text
       FROM elections
      WHERE id = $1
         OR (municipality_id = $2 AND election_date = $3)`,
    [id, municipalityId, electionDate],
  );
  if (existing.rows.length > 1) {
    throw new OfficialImportConflictError(
      "Election deterministic and natural keys resolve to different rows.",
    );
  }
  if (existing.rows[0]) {
    assertFields("Election", existing.rows[0], {
      municipality_id: municipalityId,
      name,
      election_date: electionDate,
    });
    return existing.rows[0].id;
  }
  await tx.query(
    `INSERT INTO elections (id, municipality_id, name, election_date)
     VALUES ($1, $2, $3, $4)`,
    [id, municipalityId, name, electionDate],
  );
  return id;
}

async function reconcileOffice(
  tx: Transaction,
  electionId: string,
  office: DerivedOffice,
): Promise<DerivedOffice> {
  const existing = await tx.query<{
    id: string;
    election_id: string;
    office_type: string;
    name: string;
    ward_slug: string | null;
  }>(
    `SELECT id, election_id, office_type, name, ward_slug
       FROM offices
      WHERE id = $1
         OR (
           election_id = $2
           AND office_type = $3
           AND ward_slug IS NOT DISTINCT FROM $4
         )`,
    [office.id, electionId, office.officeType, office.wardSlug],
  );
  if (existing.rows.length > 1) {
    throw new OfficialImportConflictError(
      "Office deterministic and natural keys resolve to different rows.",
    );
  }
  if (existing.rows[0]) {
    assertFields("Office", existing.rows[0], {
      election_id: electionId,
      office_type: office.officeType,
      name: office.name,
      ward_slug: office.wardSlug,
    });
    return { ...office, id: existing.rows[0].id };
  }
  await tx.query(
    `INSERT INTO offices (id, election_id, office_type, name, ward_slug)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      office.id,
      electionId,
      office.officeType,
      office.name,
      office.wardSlug,
    ],
  );
  return office;
}

async function reconcilePerson(
  tx: Transaction,
  id: string,
  displayName: string,
): Promise<void> {
  const existing = await tx.query<{ display_name: string }>(
    "SELECT display_name FROM people WHERE id = $1",
    [id],
  );
  if (existing.rows[0]) {
    assertFields("Person", existing.rows[0], {
      display_name: displayName,
    });
    return;
  }
  await tx.query("INSERT INTO people (id, display_name) VALUES ($1, $2)", [
    id,
    displayName,
  ]);
}

async function resolveOfficialPerson(
  tx: Transaction,
  municipalityId: string,
  upstreamPersonKey: string,
): Promise<{ personId: string; displayName: string } | null> {
  const existing = await tx.query<{
    person_id: string;
    display_name: string;
  }>(
    `SELECT DISTINCT c.person_id, p.display_name
       FROM candidacies c
       JOIN elections e ON e.id = c.election_id
       JOIN people p ON p.id = c.person_id
      WHERE e.municipality_id = $1
        AND c.official_person_key = $2`,
    [municipalityId, upstreamPersonKey],
  );
  if (existing.rows.length > 1) {
    throw new OfficialImportConflictError(
      "Official person upstream key resolves to multiple existing people.",
    );
  }
  const person = existing.rows[0];
  return person
    ? { personId: person.person_id, displayName: person.display_name }
    : null;
}

async function reconcileCandidate(
  tx: Transaction,
  electionId: string,
  municipalityId: string,
  officeId: string,
  candidate: OfficialRosterFixture["candidates"][number],
): Promise<DerivedCandidate> {
  const existing = await tx.query<{
    id: string;
    office_id: string;
    person_id: string;
    official_person_key: string | null;
    slug: string;
    display_name: string;
  }>(
    `SELECT DISTINCT c.id, c.office_id, c.person_id, c.official_person_key,
            c.slug, p.display_name
       FROM candidacies c
       JOIN people p ON p.id = c.person_id
       JOIN candidacy_status_history h ON h.candidacy_id = c.id
      WHERE c.election_id = $1 AND h.upstream_key = $2`,
    [electionId, candidate.upstreamKey],
  );
  if (existing.rows.length > 1) {
    throw new OfficialImportConflictError(
      "Candidacy upstream key resolves to multiple existing rows.",
    );
  }
  if (existing.rows[0]) {
    assertFields("Candidacy", existing.rows[0], {
      office_id: officeId,
      slug: candidate.slug,
      display_name: candidate.displayName,
    });
    const mappedPerson = await resolveOfficialPerson(
      tx,
      municipalityId,
      candidate.upstreamPersonKey,
    );
    if (
      existing.rows[0].official_person_key !== null &&
      existing.rows[0].official_person_key !== candidate.upstreamPersonKey
    ) {
      throw new OfficialImportConflictError(
        "Candidacy person upstream key conflicts with the existing identity.",
      );
    }
    if (
      mappedPerson &&
      mappedPerson.personId !== existing.rows[0].person_id
    ) {
      throw new OfficialImportConflictError(
        "Official person upstream key conflicts with the candidacy person.",
      );
    }
    if (
      mappedPerson &&
      mappedPerson.displayName !== candidate.displayName
    ) {
      throw new OfficialImportConflictError(
        "Official person upstream key resolves to a conflicting display name.",
      );
    }
    if (existing.rows[0].official_person_key === null) {
      await tx.query(
        `UPDATE candidacies
            SET official_person_key = $1
          WHERE id = $2 AND official_person_key IS NULL`,
        [candidate.upstreamPersonKey, existing.rows[0].id],
      );
    }
    return {
      ...candidate,
      candidacyId: existing.rows[0].id,
      personId: existing.rows[0].person_id,
      officeId,
    };
  }
  const mappedPerson = await resolveOfficialPerson(
    tx,
    municipalityId,
    candidate.upstreamPersonKey,
  );
  const personId =
    mappedPerson?.personId ??
    stableId("person", municipalityId, candidate.upstreamPersonKey);
  const candidacyId = stableId("candidacy", electionId, candidate.upstreamKey);
  if (mappedPerson && mappedPerson.displayName !== candidate.displayName) {
    throw new OfficialImportConflictError(
      "Official person upstream key resolves to a conflicting display name.",
    );
  }
  await reconcilePerson(tx, personId, candidate.displayName);
  await tx.query(
    `INSERT INTO candidacies (
       id, election_id, office_id, person_id, official_person_key, slug, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      candidacyId,
      electionId,
      officeId,
      personId,
      candidate.upstreamPersonKey,
      candidate.slug,
      candidate.status,
    ],
  );
  return { ...candidate, candidacyId, personId, officeId };
}

export async function importOfficialRosterFixture(
  db: PGlite,
  bytes: Uint8Array,
): Promise<OfficialImportResult> {
  const payloadBytes = Uint8Array.from(bytes);
  const fixture = decodeFixture(payloadBytes);
  const payloadSha256 = sha256(payloadBytes);
  const derivedMunicipalityId = stableId(
    "municipality",
    fixture.municipality.slug,
  );

  return runStage(
    db,
    {
      stage: "official-import",
      idempotencyKey: stableId(
        "official-import-stage",
        fixture.municipality.slug,
        fixture.election.electionDate,
        fixture.source.url,
        fixture.source.observedAt,
        payloadSha256,
      ),
      processorName: "official-roster-fixture-import",
      processorVersion: "2",
      inputRefs: {
        municipalitySlug: fixture.municipality.slug,
        electionDate: fixture.election.electionDate,
        sourceUrl: fixture.source.url,
        observedAt: fixture.source.observedAt,
        payloadSha256,
      },
      now: fixture.source.observedAt,
    },
    async (tx) => {
      const municipalityId = await reconcileMunicipality(
        tx,
        derivedMunicipalityId,
        fixture.municipality.slug,
        fixture.municipality.name,
      );
      const electionId = await reconcileElection(
        tx,
        stableId("election", municipalityId, fixture.election.electionDate),
        municipalityId,
        fixture.election.name,
        fixture.election.electionDate,
      );
      const existingImport = await tx.query<{
        id: string;
        payload_sha256: string;
      }>(
        `SELECT id, payload_sha256
           FROM official_import_runs
          WHERE election_id = $1 AND source_url = $2 AND observed_at = $3`,
        [electionId, fixture.source.url, fixture.source.observedAt],
      );
      if (existingImport.rows[0]) {
        if (existingImport.rows[0].payload_sha256 !== payloadSha256) {
          throw new OfficialImportConflictError(
            "Official import logical key already exists with different bytes.",
          );
        }
        const imported = await tx.query<{ candidacy_id: string }>(
          `SELECT candidacy_id
             FROM candidacy_status_history
            WHERE official_import_run_id = $1
            ORDER BY candidacy_id`,
          [existingImport.rows[0].id],
        );
        return {
          officialImportRunId: existingImport.rows[0].id,
          electionId,
          candidacyIds: imported.rows.map((row) => row.candidacy_id),
        };
      }

      const offices: DerivedOffice[] = [];
      for (const office of fixture.offices) {
        offices.push(
          await reconcileOffice(tx, electionId, {
            ...office,
            id: stableId(
              "office",
              electionId,
              office.officeType,
              office.wardSlug ?? "",
            ),
          }),
        );
      }
      const officesByKey = new Map(
        offices.map((office) => [office.key, office]),
      );
      const candidates: DerivedCandidate[] = [];
      for (const candidate of fixture.candidates) {
        const office = officesByKey.get(candidate.officeKey);
        if (!office) {
          throw new OfficialImportValidationError(
            "Official roster fixture references an unknown office.",
          );
        }
        candidates.push(
          await reconcileCandidate(
            tx,
            electionId,
            municipalityId,
            office.id,
            candidate,
          ),
        );
      }
      const officialImportRunId = stableId(
        "official-import",
        electionId,
        fixture.source.url,
        fixture.source.observedAt,
      );

      await tx.query(
        `INSERT INTO official_import_runs (
           id, election_id, source_url, observed_at, content_type, encoding,
           raw_payload, byte_length, payload_sha256, imported_count
         ) VALUES (
           $1, $2, $3, $4, 'application/json', 'utf-8', $5, $6, $7, $8
         )`,
        [
          officialImportRunId,
          electionId,
          fixture.source.url,
          fixture.source.observedAt,
          payloadBytes,
          payloadBytes.byteLength,
          payloadSha256,
          candidates.length,
        ],
      );

      for (const candidate of candidates) {
        const existingObservation = await tx.query<{
          status: string;
          upstream_key: string;
          official_import_run_id: string | null;
        }>(
          `SELECT status, upstream_key, official_import_run_id
             FROM candidacy_status_history
            WHERE candidacy_id = $1 AND observed_at = $2`,
          [candidate.candidacyId, fixture.source.observedAt],
        );
        if (existingObservation.rows[0]) {
          assertFields("Candidacy status observation", existingObservation.rows[0], {
            status: candidate.status,
            upstream_key: candidate.upstreamKey,
          });
          const linkedRunId =
            existingObservation.rows[0].official_import_run_id;
          if (linkedRunId !== null && linkedRunId !== officialImportRunId) {
            throw new OfficialImportConflictError(
              "Candidacy status observation already belongs to another official import.",
            );
          }
          if (linkedRunId === null) {
            await tx.query(
              `UPDATE candidacy_status_history
                  SET official_import_run_id = $1
                WHERE candidacy_id = $2
                  AND observed_at = $3
                  AND official_import_run_id IS NULL`,
              [
                officialImportRunId,
                candidate.candidacyId,
                fixture.source.observedAt,
              ],
            );
          }
        } else {
          await tx.query(
            `INSERT INTO candidacy_status_history (
               id, candidacy_id, status, observed_at, upstream_key,
               official_import_run_id
             ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              stableId(
                "status",
                candidate.candidacyId,
                candidate.status,
                fixture.source.observedAt,
              ),
              candidate.candidacyId,
              candidate.status,
              fixture.source.observedAt,
              candidate.upstreamKey,
              officialImportRunId,
            ],
          );
        }
        await tx.query(
          `UPDATE candidacies
              SET status = (
                SELECT status
                  FROM candidacy_status_history
                 WHERE candidacy_id = $1
                 ORDER BY observed_at DESC,
                          official_import_run_id DESC NULLS LAST,
                          id DESC
                 LIMIT 1
              )
            WHERE id = $1`,
          [candidate.candidacyId],
        );
      }

      return {
        officialImportRunId,
        electionId,
        candidacyIds: candidates.map((candidate) => candidate.candidacyId),
      };
    },
  );
}
