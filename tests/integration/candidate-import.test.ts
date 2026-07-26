import type { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OfficialImportConflictError,
  OfficialImportValidationError,
} from "@/lib/core/errors";
import { sha256 } from "@/lib/core/hash";
import { createMemoryDatabase } from "@/lib/db/client";
import {
  importOfficialRosterFixture,
  type OfficialRosterFixture,
} from "@/lib/ingest/candidates";
import { runStage } from "@/lib/pipeline/stage";
import { getPublicCandidateRecord } from "@/lib/publication/public";

let db: PGlite;

const fixturePath = path.join(
  process.cwd(),
  "tests/fixtures/official-candidates.json",
);

async function readFixtureBytes(): Promise<Uint8Array> {
  return readFile(fixturePath);
}

async function readFixture(): Promise<OfficialRosterFixture> {
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

function encodeFixture(fixture: OfficialRosterFixture): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(fixture));
}

beforeEach(async () => {
  db = await createMemoryDatabase();
});

afterEach(async () => {
  await db.close();
});

describe("official roster import and lookup", () => {
  it("rejects malformed bytes without stage or domain rows", async () => {
    await expect(
      importOfficialRosterFixture(db, new Uint8Array()),
    ).rejects.toThrow(OfficialImportValidationError);
    await expect(
      importOfficialRosterFixture(db, new TextEncoder().encode("{")),
    ).rejects.toThrow(OfficialImportValidationError);
    const counts = await db.query<{
      candidacies: number;
      imports: number;
      stages: number;
    }>(
      `SELECT
        (SELECT COUNT(*)::integer FROM candidacies) AS candidacies,
        (SELECT COUNT(*)::integer FROM official_import_runs) AS imports,
        (SELECT COUNT(*)::integer FROM stage_runs
          WHERE stage = 'official-import') AS stages`,
    );
    expect(counts.rows[0]).toEqual({
      candidacies: 0,
      imports: 0,
      stages: 0,
    });
  });

  it("enforces byte, UTF-8, strict-schema, and fixture identity boundaries", async () => {
    await expect(
      importOfficialRosterFixture(db, new Uint8Array(262_145)),
    ).rejects.toThrow(OfficialImportValidationError);
    await expect(
      importOfficialRosterFixture(db, new Uint8Array([0xff])),
    ).rejects.toThrow(OfficialImportValidationError);

    const fixture = await readFixture();
    const invalidFixtures: unknown[] = [];
    invalidFixtures.push({
      ...structuredClone(fixture),
      unexpected: true,
    });
    const duplicateOffice = structuredClone(fixture);
    duplicateOffice.offices.push(structuredClone(duplicateOffice.offices[0]));
    invalidFixtures.push(duplicateOffice);
    const unknownOffice = structuredClone(fixture);
    unknownOffice.candidates[0].officeKey = "missing-office";
    invalidFixtures.push(unknownOffice);
    const duplicateCandidate = structuredClone(fixture);
    duplicateCandidate.candidates.push(
      structuredClone(duplicateCandidate.candidates[0]),
    );
    invalidFixtures.push(duplicateCandidate);
    const conflictingPerson = structuredClone(fixture);
    conflictingPerson.candidates.push({
      ...structuredClone(conflictingPerson.candidates[0]),
      upstreamKey: "candidate:second",
      slug: "second-candidate",
      displayName: "Conflicting Name",
    });
    invalidFixtures.push(conflictingPerson);

    for (const invalid of invalidFixtures) {
      await expect(
        importOfficialRosterFixture(
          db,
          new TextEncoder().encode(JSON.stringify(invalid)),
        ),
      ).rejects.toThrow(OfficialImportValidationError);
    }
  });

  it("preserves exact bytes and returns the same result on exact replay", async () => {
    const bytes = await readFixtureBytes();
    const first = await importOfficialRosterFixture(db, bytes);
    const second = await importOfficialRosterFixture(db, bytes);
    expect(second).toEqual(first);

    const stored = await db.query<{
      raw_payload: Uint8Array;
      byte_length: number;
      payload_sha256: string;
      imported_count: number;
      history_count: number;
    }>(
      `SELECT raw_payload, byte_length, payload_sha256, imported_count,
              (SELECT COUNT(*)::integer
                 FROM candidacy_status_history) AS history_count
         FROM official_import_runs`,
    );
    expect(Buffer.from(stored.rows[0].raw_payload)).toEqual(Buffer.from(bytes));
    expect(stored.rows[0]).toMatchObject({
      byte_length: bytes.byteLength,
      payload_sha256: sha256(bytes),
      imported_count: 1,
      history_count: 1,
    });
    expect(first.candidacyIds[0]).toMatch(/^candidacy_[a-f0-9]{24}$/);
  });

  it("snapshots caller-owned bytes before queued execution", async () => {
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = runStage(
      db,
      {
        stage: "queue-blocker",
        idempotencyKey: "queue-blocker",
        processorName: "test",
        processorVersion: "1",
        inputRefs: {},
        now: "2026-07-24T11:59:00.000Z",
      },
      async () => {
        entered();
        await releasePromise;
        return { released: true };
      },
    );
    await enteredPromise;

    const bytes = await readFixtureBytes();
    const expectedHash = sha256(bytes);
    const importPromise = importOfficialRosterFixture(db, bytes);
    bytes[0] ^= 0xff;
    release();
    await blocker;
    await importPromise;

    const stored = await db.query<{
      raw_payload: Uint8Array;
      payload_sha256: string;
    }>("SELECT raw_payload, payload_sha256 FROM official_import_runs");
    expect(stored.rows[0].payload_sha256).toBe(expectedHash);
    expect(sha256(stored.rows[0].raw_payload)).toBe(expectedHash);
  });

  it("rejects changed bytes at the same logical import key", async () => {
    const fixture = await readFixture();
    await importOfficialRosterFixture(db, encodeFixture(fixture));
    const changed = structuredClone(fixture);
    changed.candidates[0].displayName = "Different Synthetic Name";

    await expect(
      importOfficialRosterFixture(db, encodeFixture(changed)),
    ).rejects.toThrow(OfficialImportConflictError);
    const counts = await db.query<{ imports: number; failed: number }>(
      `SELECT
        (SELECT COUNT(*)::integer FROM official_import_runs) AS imports,
        (SELECT COUNT(*)::integer FROM stage_runs
          WHERE stage = 'official-import' AND status = 'failed') AS failed`,
    );
    expect(counts.rows[0]).toEqual({ imports: 1, failed: 1 });
  });

  it("appends later status, ignores older status for current state, and exposes the latest", async () => {
    const fixture = await readFixture();
    const initial = await importOfficialRosterFixture(db, encodeFixture(fixture));

    const later = structuredClone(fixture);
    later.source.url =
      "https://example.invalid/municipal-election/candidates-august.json";
    later.source.observedAt = "2026-08-01T12:00:00.000Z";
    later.candidates[0].status = "withdrawn";
    await importOfficialRosterFixture(db, encodeFixture(later));

    const older = structuredClone(fixture);
    older.source.url =
      "https://example.invalid/municipal-election/candidates-july.json";
    older.source.observedAt = "2026-07-20T12:00:00.000Z";
    older.candidates[0].status = "registered";
    await importOfficialRosterFixture(db, encodeFixture(older));

    const result = await db.query<{ status: string; history_count: number }>(
      `SELECT c.status,
              (SELECT COUNT(*)::integer
                 FROM candidacy_status_history h
                WHERE h.candidacy_id = c.id) AS history_count
         FROM candidacies c
        WHERE c.id = $1`,
      [initial.candidacyIds[0]],
    );
    expect(result.rows[0]).toEqual({
      status: "withdrawn",
      history_count: 3,
    });
    const publicRecord = await getPublicCandidateRecord(db, "demo-candidate");
    expect(publicRecord?.candidacyStatus).toBe("withdrawn");
  });

  it("rolls back identity and equal-time status conflicts", async () => {
    const fixture = await readFixture();
    const imported = await importOfficialRosterFixture(
      db,
      encodeFixture(fixture),
    );
    await db.query(
      "UPDATE people SET display_name = 'Conflicting Stored Name' WHERE id = (SELECT person_id FROM candidacies WHERE id = $1)",
      [imported.candidacyIds[0]],
    );
    const later = structuredClone(fixture);
    later.source.url =
      "https://example.invalid/municipal-election/candidates-later.json";
    later.source.observedAt = "2026-08-02T12:00:00.000Z";
    await expect(
      importOfficialRosterFixture(db, encodeFixture(later)),
    ).rejects.toThrow(OfficialImportConflictError);

    await db.query(
      "UPDATE people SET display_name = $1 WHERE id = (SELECT person_id FROM candidacies WHERE id = $2)",
      [fixture.candidates[0].displayName, imported.candidacyIds[0]],
    );
    const sameTime = structuredClone(fixture);
    sameTime.source.url =
      "https://example.invalid/municipal-election/candidates-mirror.json";
    sameTime.candidates[0].status = "withdrawn";
    await expect(
      importOfficialRosterFixture(db, encodeFixture(sameTime)),
    ).rejects.toThrow(OfficialImportConflictError);

    const sameStatusMirror = structuredClone(fixture);
    sameStatusMirror.source.url =
      "https://example.invalid/municipal-election/candidates-same-status.json";
    await expect(
      importOfficialRosterFixture(db, encodeFixture(sameStatusMirror)),
    ).rejects.toThrow(OfficialImportConflictError);

    const counts = await db.query<{ imports: number; history: number }>(
      `SELECT
        (SELECT COUNT(*)::integer FROM official_import_runs) AS imports,
        (SELECT COUNT(*)::integer FROM candidacy_status_history) AS history`,
    );
    expect(counts.rows[0]).toEqual({ imports: 1, history: 1 });
  });

  it("rejects a changed person upstream key atomically", async () => {
    const fixture = await readFixture();
    await importOfficialRosterFixture(db, encodeFixture(fixture));
    const changed = structuredClone(fixture);
    changed.source.url =
      "https://example.invalid/municipal-election/candidates-person-change.json";
    changed.source.observedAt = "2026-08-03T12:00:00.000Z";
    changed.candidates[0].upstreamPersonKey = "person:different";

    await expect(
      importOfficialRosterFixture(db, encodeFixture(changed)),
    ).rejects.toThrow(OfficialImportConflictError);
    const counts = await db.query<{ imports: number; history: number }>(
      `SELECT
        (SELECT COUNT(*)::integer FROM official_import_runs) AS imports,
        (SELECT COUNT(*)::integer FROM candidacy_status_history) AS history`,
    );
    expect(counts.rows[0]).toEqual({ imports: 1, history: 1 });
  });

  it("reuses a legacy person identity for a later candidacy with the same official key", async () => {
    const fixture = await readFixture();
    await db.query(
      `INSERT INTO municipalities (id, slug, name)
       VALUES ('legacy_municipality', $1, $2)`,
      [fixture.municipality.slug, fixture.municipality.name],
    );
    await db.query(
      `INSERT INTO elections (
         id, municipality_id, name, election_date
       ) VALUES ('legacy_election', 'legacy_municipality', $1, $2)`,
      [fixture.election.name, fixture.election.electionDate],
    );
    await db.query(
      `INSERT INTO offices (
         id, election_id, office_type, name, ward_slug
       ) VALUES (
         'legacy_office', 'legacy_election', $1, $2, $3
       )`,
      [
        fixture.offices[0].officeType,
        fixture.offices[0].name,
        fixture.offices[0].wardSlug,
      ],
    );
    await db.query(
      "INSERT INTO people (id, display_name) VALUES ('legacy_person', $1)",
      [fixture.candidates[0].displayName],
    );
    await db.query(
      `INSERT INTO candidacies (
         id, election_id, office_id, person_id, slug, status
       ) VALUES (
         'legacy_candidacy', 'legacy_election', 'legacy_office',
         'legacy_person', $1, $2
       )`,
      [fixture.candidates[0].slug, fixture.candidates[0].status],
    );
    await db.query(
      `INSERT INTO candidacy_status_history (
         id, candidacy_id, status, observed_at, upstream_key
       ) VALUES (
         'legacy_status', 'legacy_candidacy', $1,
         '2026-07-01T12:00:00.000Z', $2
       )`,
      [fixture.candidates[0].status, fixture.candidates[0].upstreamKey],
    );

    await importOfficialRosterFixture(db, encodeFixture(fixture));
    const later = structuredClone(fixture);
    later.source.url =
      "https://example.invalid/municipal-election/candidates-second-office.json";
    later.source.observedAt = "2026-08-04T12:00:00.000Z";
    later.offices.push({
      key: "ward-one",
      officeType: "councillor",
      name: "Ward 1 Councillor",
      wardSlug: "ward-1",
    });
    later.candidates.push({
      ...structuredClone(later.candidates[0]),
      upstreamKey: "candidate:demo-ward-one",
      slug: "demo-candidate-ward-one",
      officeKey: "ward-one",
    });
    await importOfficialRosterFixture(db, encodeFixture(later));

    const identity = await db.query<{
      people: number;
      candidacies: number;
      person_ids: string[];
    }>(
      `SELECT
        (SELECT COUNT(*)::integer FROM people) AS people,
        COUNT(*)::integer AS candidacies,
        array_agg(DISTINCT person_id ORDER BY person_id) AS person_ids
       FROM candidacies`,
    );
    expect(identity.rows[0]).toEqual({
      people: 1,
      candidacies: 2,
      person_ids: ["legacy_person"],
    });
  });

  it("returns null for an unknown public candidacy", async () => {
    await expect(getPublicCandidateRecord(db, "unknown")).resolves.toBeNull();
  });
});
