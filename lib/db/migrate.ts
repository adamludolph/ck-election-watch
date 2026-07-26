import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import {
  DatabasePreparationError,
  MigrationIntegrityError,
} from "@/lib/core/errors";
import { sha256 } from "@/lib/core/hash";

export const migrationFiles = [
  "drizzle/0000_evidence_pipeline.sql",
  "drizzle/0001_discovery_official_import.sql",
  "drizzle/0002_import_review_hardening.sql",
  "drizzle/0003_official_person_backfill.sql",
] as const;

export async function applyMigrations(db: PGlite): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS app_migrations (
      name text PRIMARY KEY,
      sha256 text NOT NULL,
      applied_at timestamptz NOT NULL
    );
  `);

  for (const migrationFile of migrationFiles) {
    const sql = await readFile(path.join(process.cwd(), migrationFile), "utf8");
    const digest = sha256(sql);
    const existing = await db.query<{ sha256: string }>(
      "SELECT sha256 FROM app_migrations WHERE name = $1",
      [migrationFile],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].sha256 !== digest) {
        throw new MigrationIntegrityError(
          `Applied migration ${migrationFile} has changed.`,
        );
      }
      continue;
    }

    try {
      await db.transaction(async (tx) => {
        await tx.exec(sql);
        await tx.query(
          "INSERT INTO app_migrations (name, sha256, applied_at) VALUES ($1, $2, $3)",
          [migrationFile, digest, new Date().toISOString()],
        );
      });
    } catch (error) {
      throw new DatabasePreparationError(
        `Unable to apply migration ${migrationFile}.`,
        error,
      );
    }
  }
}
