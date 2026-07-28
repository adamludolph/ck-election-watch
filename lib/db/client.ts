import path from "node:path";
import { mkdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { applyMigrations } from "@/lib/db/migrate";

declare global {
  var electionExplorerDb: Promise<PGlite> | undefined;
}

async function createDatabase(dataDir?: string): Promise<PGlite> {
  if (dataDir) {
    await mkdir(dataDir, { recursive: true });
  }
  const db = await PGlite.create({
    dataDir: dataDir ?? "memory://",
    extensions: { vector },
  });
  await applyMigrations(db);
  return db;
}

export function createMemoryDatabase(): Promise<PGlite> {
  return createDatabase();
}

export function createFileDatabase(dataDir: string): Promise<PGlite> {
  return createDatabase(dataDir);
}

export function getAppDatabase(): Promise<PGlite> {
  if (!globalThis.electionExplorerDb) {
    const dataDir = path.join(process.cwd(), ".data", "election-explorer");
    globalThis.electionExplorerDb = createDatabase(dataDir);
  }
  return globalThis.electionExplorerDb;
}
