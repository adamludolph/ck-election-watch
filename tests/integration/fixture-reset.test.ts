import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterEach, describe, expect, it } from "vitest";
import { getReviewQueue } from "@/lib/editorial/queries";
import { performEditorialAction } from "@/lib/editorial/workflow";
import { getPublicCandidateRecord } from "@/lib/publication/public";

const execFileAsync = promisify(execFile);
const openDatabases: PGlite[] = [];
const dataDir = path.join(
  process.cwd(),
  ".data",
  "test",
  `fixture-reset-${process.pid}`,
);

async function prepare(): Promise<void> {
  await execFileAsync(
    process.execPath,
    [
      path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(process.cwd(), "scripts", "prepare-demo.ts"),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ELECTION_EXPLORER_DATA_DIR: dataDir,
      },
      windowsHide: true,
    },
  );
}

async function openFixture(): Promise<PGlite> {
  const db = await PGlite.create({ dataDir, extensions: { vector } });
  openDatabases.push(db);
  return db;
}

async function snapshot(db: PGlite) {
  const queue = await getReviewQueue(db, "all");
  const events = await db.query<{
    editorial: number;
    publication: number;
  }>(
    `SELECT
      (SELECT COUNT(*)::integer FROM statement_editorial_events) AS editorial,
      (SELECT COUNT(*)::integer FROM publication_events) AS publication`,
  );
  return {
    counts: queue.counts,
    events: events.rows[0],
    public: await getPublicCandidateRecord(db, "demo-candidate"),
  };
}

afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map((db) => db.close()));
  await rm(dataDir, { recursive: true, force: true });
});

describe("fixture database reset", () => {
  it(
    "restores the exact baseline after editorial mutations",
    async () => {
      await prepare();
      const firstDb = await openFixture();
      const baseline = await snapshot(firstDb);
      const queue = await getReviewQueue(firstDb, "needs_review");
      const roads = queue.records.find((record) =>
        record.summary.includes("preventive road maintenance"),
      );
      if (!roads) {
        throw new Error("Roads fixture was not prepared.");
      }
      await performEditorialAction(
        firstDb,
        {
          action: "reviewed_ready",
          statementId: roads.statementId,
          requestId: "reset-proof:roads:review",
          operatorRef: "fixture:reset-proof",
          expectedPhase: "needs_review",
        },
        () => "2026-07-24T19:00:00.000Z",
      );
      await firstDb.close();
      openDatabases.splice(openDatabases.indexOf(firstDb), 1);

      await prepare();
      const secondDb = await openFixture();
      expect(await snapshot(secondDb)).toEqual(baseline);
    },
    60_000,
  );
});
