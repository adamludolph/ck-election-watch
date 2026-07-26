import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CandidateImportValidationError } from "@/lib/core/errors";
import { createMemoryDatabase } from "@/lib/db/client";
import { importCandidateFixture } from "@/lib/ingest/candidates";
import { getPublicCandidateRecord } from "@/lib/publication/public";

let db: PGlite;

beforeEach(async () => {
  db = await createMemoryDatabase();
});

afterEach(async () => {
  await db.close();
});

describe("candidate import and lookup", () => {
  it("rejects malformed official input without partial rows", async () => {
    await expect(importCandidateFixture(db, { municipality: {} })).rejects.toThrow(
      CandidateImportValidationError,
    );
    const count = await db.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM candidacies",
    );
    expect(count.rows[0].count).toBe(0);
  });

  it("returns null for an unknown public candidacy", async () => {
    await expect(getPublicCandidateRecord(db, "unknown")).resolves.toBeNull();
  });

  it("records later official status observations and exposes the latest status", async () => {
    const fixture = JSON.parse(
      await readFile(
        path.join(process.cwd(), "tests/fixtures/official-candidates.json"),
        "utf8",
      ),
    ) as {
      candidacy: { id: string; slug: string; status: string };
      observedAt: string;
    };
    await importCandidateFixture(db, fixture);
    await importCandidateFixture(db, {
      ...fixture,
      candidacy: { ...fixture.candidacy, status: "withdrawn" },
      observedAt: "2026-08-01T12:00:00.000Z",
    });
    const result = await db.query<{ status: string; history_count: number }>(
      `SELECT c.status,
              (
                SELECT COUNT(*)::integer
                  FROM candidacy_status_history h
                 WHERE h.candidacy_id = c.id
              ) AS history_count
         FROM candidacies c
        LIMIT 1`,
    );
    expect(result.rows[0]).toEqual({
      status: "withdrawn",
      history_count: 2,
    });
    const publicRecord = await getPublicCandidateRecord(
      db,
      fixture.candidacy.slug,
    );
    expect(publicRecord?.candidacyStatus).toBe("withdrawn");
  });
});
