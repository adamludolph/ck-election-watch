import { createFileDatabase } from "@/lib/db/client";
import { DatabasePreparationError } from "@/lib/core/errors";
import { prepareDemoDatabase } from "@/lib/pipeline/prepare-demo";
import { rm } from "node:fs/promises";
import path from "node:path";

function resolveFixtureDatabasePath(): string {
  const repositoryRoot = path.resolve(process.cwd());
  const canonicalTarget = path.join(
    repositoryRoot,
    ".data",
    "election-explorer",
  );
  const testRoot = path.join(repositoryRoot, ".data", "test");
  const target = path.resolve(
    process.env.ELECTION_EXPLORER_DATA_DIR ?? canonicalTarget,
  );
  const isCanonicalTarget = target === canonicalTarget;
  const isIsolatedTestTarget = target.startsWith(`${testRoot}${path.sep}`);
  if (
    (!isCanonicalTarget && !isIsolatedTestTarget) ||
    !target.startsWith(`${repositoryRoot}${path.sep}`)
  ) {
    throw new DatabasePreparationError(
      "Refusing to reset a database outside the repository fixture paths.",
    );
  }
  return target;
}

async function resetFixtureDatabase(target: string): Promise<void> {
  const repositoryRoot = path.resolve(process.cwd());
  const canonicalTarget = path.join(
    repositoryRoot,
    ".data",
    "election-explorer",
  );
  const testRoot = path.join(repositoryRoot, ".data", "test");
  if (
    (target !== canonicalTarget && !target.startsWith(`${testRoot}${path.sep}`)) ||
    !target.startsWith(`${repositoryRoot}${path.sep}`)
  ) {
    throw new DatabasePreparationError(
      "Refusing to reset a database outside the repository fixture paths.",
    );
  }
  await rm(target, { recursive: true, force: true });
}

async function main(): Promise<void> {
  try {
    const target = resolveFixtureDatabasePath();
    await resetFixtureDatabase(target);
    const db = await createFileDatabase(target);
    const result = await prepareDemoDatabase(db);
    console.log(
      `Prepared ${result.candidacyId} with publication ${result.publicationId}.`,
    );
    await db.close();
  } catch (error) {
    const wrapped =
      error instanceof DatabasePreparationError
        ? error
        : new DatabasePreparationError(
            "Unable to prepare the local demonstration database.",
            error,
          );
    console.error(`${wrapped.code}: ${wrapped.message}`);
    if (wrapped.cause instanceof Error) {
      console.error(wrapped.cause.message);
    }
    process.exitCode = 1;
  }
}

void main();
