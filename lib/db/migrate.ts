import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { sha256 } from "@/lib/core/hash";

const migrationFile = "drizzle/0000_evidence_pipeline.sql";

export async function applyMigrations(db: PGlite): Promise<void> {
  const sql = await readFile(path.join(process.cwd(), migrationFile), "utf8");
  const digest = sha256(sql);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS app_migrations (
      name text PRIMARY KEY,
      sha256 text NOT NULL,
      applied_at timestamptz NOT NULL
    );
  `);
  const existing = await db.query<{ sha256: string }>(
    "SELECT sha256 FROM app_migrations WHERE name = $1",
    [migrationFile],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].sha256 !== digest) {
      throw new Error(`Applied migration ${migrationFile} has changed.`);
    }
    return;
  }
  await db.exec(sql);
  await db.query(
    "INSERT INTO app_migrations (name, sha256, applied_at) VALUES ($1, $2, $3)",
    [migrationFile, digest, new Date().toISOString()],
  );
}
