import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterEach, describe, expect, it } from "vitest";
import {
  DatabasePreparationError,
  MigrationIntegrityError,
} from "@/lib/core/errors";
import { sha256, stableId } from "@/lib/core/hash";
import { applyMigrations } from "@/lib/db/migrate";
import { importOfficialRosterFixture } from "@/lib/ingest/candidates";
import { prepareDemoDatabase } from "@/lib/pipeline/prepare-demo";
import { seedMilestone2Publication } from "@/tests/support/milestone2-publication";

const openDatabases: PGlite[] = [];
const migration0 = "drizzle/0000_evidence_pipeline.sql";
const milestone2Migrations = [
  migration0,
  "drizzle/0001_discovery_official_import.sql",
  "drizzle/0002_import_review_hardening.sql",
  "drizzle/0003_official_person_backfill.sql",
] as const;

async function createRawDatabase(): Promise<PGlite> {
  const db = await PGlite.create({
    dataDir: "memory://",
    extensions: { vector },
  });
  openDatabases.push(db);
  return db;
}

async function applyLegacyBaseline(db: PGlite): Promise<void> {
  const sql = await readFile(path.join(process.cwd(), migration0), "utf8");
  await db.exec(`
    CREATE TABLE app_migrations (
      name text PRIMARY KEY,
      sha256 text NOT NULL,
      applied_at timestamptz NOT NULL
    );
  `);
  await db.transaction(async (tx) => {
    await tx.exec(sql);
    await tx.query(
      "INSERT INTO app_migrations (name, sha256, applied_at) VALUES ($1, $2, $3)",
      [migration0, sha256(sql), "2026-07-24T00:00:00.000Z"],
    );
  });
}

async function applyMilestone2Baseline(db: PGlite): Promise<void> {
  await db.exec(`
    CREATE TABLE app_migrations (
      name text PRIMARY KEY,
      sha256 text NOT NULL,
      applied_at timestamptz NOT NULL
    );
  `);
  for (const [index, migration] of milestone2Migrations.entries()) {
    const sql = await readFile(path.join(process.cwd(), migration), "utf8");
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query(
        "INSERT INTO app_migrations (name, sha256, applied_at) VALUES ($1, $2, $3)",
        [
          migration,
          sha256(sql),
          `2026-07-24T00:0${index}:00.000Z`,
        ],
      );
    });
  }
}

async function prepareMilestone2Fixture(db: PGlite) {
  const prepared = await prepareDemoDatabase(db, {
    seedEditorialWorkflow: false,
  });
  const statementId = prepared.statementIds["statement-healthcare"];
  if (!statementId) {
    throw new Error("Milestone 2 healthcare fixture was not created.");
  }
  const publication = await seedMilestone2Publication(db, statementId);
  return { ...prepared, publicationId: publication.publicationId };
}

afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map((db) => db.close()));
});

describe("ordered migrations", () => {
  it("applies every migration to an empty database", async () => {
    const db = await createRawDatabase();
    await applyMigrations(db);
    const result = await db.query<{ migrations: number; discovered: string }>(
      `SELECT
        (SELECT COUNT(*)::integer FROM app_migrations) AS migrations,
        to_regclass('public.discovered_sources')::text AS discovered`,
    );
    expect(result.rows[0]).toEqual({
      migrations: 5,
      discovered: "discovered_sources",
    });
  });

  it("upgrades a clean 0000 database and records only the forward migration", async () => {
    const db = await createRawDatabase();
    await applyLegacyBaseline(db);
    await applyMigrations(db);
    const migrations = await db.query<{ name: string }>(
      "SELECT name FROM app_migrations ORDER BY name",
    );
    expect(migrations.rows.map((row) => row.name)).toEqual([
      "drizzle/0000_evidence_pipeline.sql",
      "drizzle/0001_discovery_official_import.sql",
      "drizzle/0002_import_review_hardening.sql",
      "drizzle/0003_official_person_backfill.sql",
      "drizzle/0004_editorial_review_controls.sql",
    ]);
  });

  it("upgrades the exact Milestone 2 fixture with immutable approval and publication history", async () => {
    const db = await createRawDatabase();
    await applyMilestone2Baseline(db);
    const prepared = await prepareMilestone2Fixture(db);

    await applyMigrations(db);

    const state = await db.query<{
      status: string;
      editorial_events: number;
      publication_events: number;
      active_publications: number;
      approved_event_id: string;
    }>(
      `SELECT
        st.status,
        (SELECT COUNT(*)::integer
           FROM statement_editorial_events) AS editorial_events,
        (SELECT COUNT(*)::integer
           FROM publication_events) AS publication_events,
        (SELECT COUNT(*)::integer
           FROM active_publication_payloads) AS active_publications,
        pe.approved_editorial_event_id AS approved_event_id
       FROM publications p
       JOIN statements st ON st.id = p.statement_id
       JOIN publication_events pe
         ON pe.publication_id = p.id AND pe.event_type = 'published'
      WHERE p.id = $1`,
      [prepared.publicationId],
    );
    expect(state.rows[0]).toEqual({
      status: "approved",
      editorial_events: 1,
      publication_events: 1,
      active_publications: 1,
      approved_event_id: expect.stringContaining(
        "migration-editorial-approved-",
      ),
    });

    await applyMigrations(db);
    const replayCounts = await db.query<{
      editorial: number;
      publication: number;
    }>(
      `SELECT
        (SELECT COUNT(*)::integer FROM statement_editorial_events) AS editorial,
        (SELECT COUNT(*)::integer FROM publication_events) AS publication`,
    );
    expect(replayCounts.rows[0]).toEqual({
      editorial: 1,
      publication: 1,
    });
  });

  it("migrates a closed Milestone 2 publication to terminal withdrawal with a fixed reason", async () => {
    const db = await createRawDatabase();
    await applyMilestone2Baseline(db);
    const prepared = await prepareMilestone2Fixture(db);
    await db.query(
      `UPDATE publications
          SET withdrawn_at = '2026-07-24T16:11:00.000Z',
              withdrawal_reason = NULL
        WHERE id = $1`,
      [prepared.publicationId],
    );

    await applyMigrations(db);

    const state = await db.query<{
      status: string;
      reason: string;
      editorial_events: number;
      publication_events: number;
      active_publications: number;
    }>(
      `SELECT
        st.status,
        pe.reason,
        (SELECT COUNT(*)::integer
           FROM statement_editorial_events) AS editorial_events,
        (SELECT COUNT(*)::integer
           FROM publication_events) AS publication_events,
        (SELECT COUNT(*)::integer
           FROM active_publication_payloads) AS active_publications
       FROM publications p
       JOIN statements st ON st.id = p.statement_id
       JOIN publication_events pe
         ON pe.publication_id = p.id AND pe.event_type = 'unpublished'
      WHERE p.id = $1`,
      [prepared.publicationId],
    );
    expect(state.rows[0]).toEqual({
      status: "withdrawn",
      reason: "Migrated legacy withdrawal without recorded reason.",
      editorial_events: 2,
      publication_events: 2,
      active_publications: 0,
    });

    await expect(
      db.query(
        "UPDATE statement_editorial_events SET reason = 'changed' WHERE event_type = 'withdrawn'",
      ),
    ).rejects.toThrow("append-only");
    await expect(
      db.query(
        "DELETE FROM publication_events WHERE event_type = 'unpublished'",
      ),
    ).rejects.toThrow("append-only");
    await expect(
      db.query(
        "UPDATE publications SET payload = jsonb_set(payload, '{summary}', '\"changed\"'::jsonb)",
      ),
    ).rejects.toThrow("publication snapshot is immutable");
    await expect(
      db.query("DELETE FROM publications WHERE id = $1", [
        prepared.publicationId,
      ]),
    ).rejects.toThrow("publication snapshot is immutable");
  });

  it.each([
    {
      name: "approved statement without publication",
      mutate: async (db: PGlite) => {
        await db.query(
          "UPDATE statements SET status = 'approved', approved_at = '2026-07-24T16:09:00Z' WHERE status = 'draft'",
        );
      },
    },
    {
      name: "publication on a non-approved statement",
      mutate: async (db: PGlite) => {
        await db.query(
          "UPDATE statements SET status = 'draft', approved_at = NULL WHERE status = 'approved'",
        );
      },
    },
    {
      name: "approved publication without approved_at",
      mutate: async (db: PGlite) => {
        await db.query(
          "UPDATE statements SET approved_at = NULL WHERE status = 'approved'",
        );
      },
    },
    {
      name: "approval after publication",
      mutate: async (db: PGlite) => {
        await db.query(
          `UPDATE statements st
              SET approved_at = p.published_at + interval '1 second'
             FROM publications p
            WHERE p.statement_id = st.id`,
        );
      },
    },
    {
      name: "withdrawal before publication",
      mutate: async (db: PGlite) => {
        await db.query(
          "UPDATE publications SET withdrawn_at = published_at - interval '1 second'",
        );
      },
    },
    {
      name: "open publication with a reason",
      mutate: async (db: PGlite) => {
        await db.query(
          "UPDATE publications SET withdrawal_reason = 'inconsistent'",
        );
      },
    },
    {
      name: "over-limit withdrawal reason",
      mutate: async (db: PGlite) => {
        await db.query(
          "UPDATE publications SET withdrawn_at = published_at + interval '1 second', withdrawal_reason = repeat('x', 501)",
        );
      },
    },
  ])("fails atomically for $name", async ({ mutate }) => {
    const db = await createRawDatabase();
    await applyMilestone2Baseline(db);
    await prepareMilestone2Fixture(db);
    await mutate(db);

    await expect(applyMigrations(db)).rejects.toThrow(
      DatabasePreparationError,
    );
    const state = await db.query<{
      migration: number;
      events: string | null;
    }>(
      `SELECT
        (SELECT COUNT(*)::integer
           FROM app_migrations
          WHERE name = 'drizzle/0004_editorial_review_controls.sql') AS migration,
        to_regclass('public.statement_editorial_events')::text AS events`,
    );
    expect(state.rows[0]).toEqual({ migration: 0, events: null });
  });

  it("refuses an applied migration digest mismatch", async () => {
    const db = await createRawDatabase();
    await applyMigrations(db);
    await db.query(
      `UPDATE app_migrations
          SET sha256 = repeat('0', 64)
        WHERE name = 'drizzle/0001_discovery_official_import.sql'`,
    );
    await expect(applyMigrations(db)).rejects.toThrow(
      MigrationIntegrityError,
    );
  });

  it("adds official identity and indexed upstream lookup hardening", async () => {
    const db = await createRawDatabase();
    await applyMigrations(db);
    const result = await db.query<{
      person_key: string | null;
      upstream_index: string | null;
    }>(
      `SELECT
        (
          SELECT column_name
            FROM information_schema.columns
           WHERE table_name = 'candidacies'
             AND column_name = 'official_person_key'
        ) AS person_key,
        to_regclass('public.candidacy_status_upstream_lookup_idx')::text
          AS upstream_index`,
    );
    expect(result.rows[0]).toEqual({
      person_key: "official_person_key",
      upstream_index: "candidacy_status_upstream_lookup_idx",
    });
  });

  it("backfills official person identity before a cached import replay", async () => {
    const db = await createRawDatabase();
    await applyLegacyBaseline(db);
    const migration1 = "drizzle/0001_discovery_official_import.sql";
    const migrationSql = await readFile(
      path.join(process.cwd(), migration1),
      "utf8",
    );
    await db.transaction(async (tx) => {
      await tx.exec(migrationSql);
      await tx.query(
        "INSERT INTO app_migrations (name, sha256, applied_at) VALUES ($1, $2, $3)",
        [migration1, sha256(migrationSql), "2026-07-24T00:01:00.000Z"],
      );
    });

    const fixtureBytes = await readFile(
      path.join(process.cwd(), "tests/fixtures/official-candidates.json"),
    );
    const fixture = JSON.parse(fixtureBytes.toString("utf8")) as {
      municipality: { slug: string; name: string };
      election: { name: string; electionDate: string };
      source: { url: string; observedAt: string };
      offices: Array<{
        officeType: string;
        name: string;
        wardSlug: string | null;
      }>;
      candidates: Array<{
        upstreamKey: string;
        upstreamPersonKey: string;
        displayName: string;
        slug: string;
        status: string;
      }>;
    };
    const payloadHash = sha256(fixtureBytes);
    const idempotencyKey = stableId(
      "official-import-stage",
      fixture.municipality.slug,
      fixture.election.electionDate,
      fixture.source.url,
      fixture.source.observedAt,
      payloadHash,
    );
    await db.query(
      `INSERT INTO municipalities (id, slug, name)
       VALUES ('legacy_m', $1, $2)`,
      [fixture.municipality.slug, fixture.municipality.name],
    );
    await db.query(
      `INSERT INTO elections (id, municipality_id, name, election_date)
       VALUES ('legacy_e', 'legacy_m', $1, $2)`,
      [fixture.election.name, fixture.election.electionDate],
    );
    await db.query(
      `INSERT INTO offices (
         id, election_id, office_type, name, ward_slug
       ) VALUES ('legacy_o', 'legacy_e', $1, $2, $3)`,
      [
        fixture.offices[0].officeType,
        fixture.offices[0].name,
        fixture.offices[0].wardSlug,
      ],
    );
    await db.query(
      "INSERT INTO people (id, display_name) VALUES ('legacy_p', $1)",
      [fixture.candidates[0].displayName],
    );
    await db.query(
      `INSERT INTO candidacies (
         id, election_id, office_id, person_id, slug, status
       ) VALUES (
         'legacy_c', 'legacy_e', 'legacy_o', 'legacy_p', $1, $2
       )`,
      [fixture.candidates[0].slug, fixture.candidates[0].status],
    );
    await db.query(
      `INSERT INTO official_import_runs (
         id, election_id, source_url, observed_at, content_type, encoding,
         raw_payload, byte_length, payload_sha256, imported_count
       ) VALUES (
         'legacy_import', 'legacy_e', $1, $2, 'application/json', 'utf-8',
         $3, $4, $5, 1
       )`,
      [
        fixture.source.url,
        fixture.source.observedAt,
        fixtureBytes,
        fixtureBytes.byteLength,
        payloadHash,
      ],
    );
    await db.query(
      `INSERT INTO candidacy_status_history (
         id, candidacy_id, status, observed_at, upstream_key,
         official_import_run_id
       ) VALUES (
         'legacy_h', 'legacy_c', $1, $2, $3, 'legacy_import'
       )`,
      [
        fixture.candidates[0].status,
        fixture.source.observedAt,
        fixture.candidates[0].upstreamKey,
      ],
    );
    await db.query(
      `INSERT INTO stage_runs (
         id, stage, idempotency_key, attempt, processor_name,
         processor_version, config_sha256, input_refs, output_refs, status,
         started_at, completed_at
       ) VALUES (
         'legacy_stage', 'official-import', $1, 1,
         'official-roster-fixture-import', '2', $2, '{}'::jsonb,
         $3::jsonb, 'succeeded', $4, $4
       )`,
      [
        idempotencyKey,
        payloadHash,
        JSON.stringify({
          officialImportRunId: "legacy_import",
          electionId: "legacy_e",
          candidacyIds: ["legacy_c"],
        }),
        fixture.source.observedAt,
      ],
    );

    await applyMigrations(db);
    await expect(
      importOfficialRosterFixture(db, fixtureBytes),
    ).resolves.toEqual({
      officialImportRunId: "legacy_import",
      electionId: "legacy_e",
      candidacyIds: ["legacy_c"],
    });
    const identity = await db.query<{ official_person_key: string | null }>(
      "SELECT official_person_key FROM candidacies WHERE id = 'legacy_c'",
    );
    expect(identity.rows[0].official_person_key).toBe(
      fixture.candidates[0].upstreamPersonKey,
    );
  });

  it("refuses legal-under-0000 equal-time conflicts without partial schema or ledger state", async () => {
    const db = await createRawDatabase();
    await applyLegacyBaseline(db);
    await db.exec(`
      INSERT INTO municipalities (id, slug, name)
      VALUES ('m', 'm', 'M');
      INSERT INTO elections (id, municipality_id, name, election_date)
      VALUES ('e', 'm', 'E', '2026-10-26');
      INSERT INTO offices (id, election_id, office_type, name)
      VALUES ('o', 'e', 'mayor', 'Mayor');
      INSERT INTO people (id, display_name)
      VALUES ('p', 'Synthetic Person');
      INSERT INTO candidacies (id, election_id, office_id, person_id, slug, status)
      VALUES ('c', 'e', 'o', 'p', 'synthetic', 'registered');
      INSERT INTO candidacy_status_history
        (id, candidacy_id, status, observed_at, upstream_key)
      VALUES
        ('h1', 'c', 'registered', '2026-07-24T00:00:00Z', 'candidate:c'),
        ('h2', 'c', 'withdrawn', '2026-07-24T00:00:00Z', 'candidate:c');
    `);

    await expect(applyMigrations(db)).rejects.toThrow(
      DatabasePreparationError,
    );
    const state = await db.query<{
      migrations: number;
      official_table: string | null;
    }>(
      `SELECT
        (SELECT COUNT(*)::integer FROM app_migrations) AS migrations,
        to_regclass('public.official_import_runs')::text AS official_table`,
    );
    expect(state.rows[0]).toEqual({
      migrations: 1,
      official_table: null,
    });
  });
});
