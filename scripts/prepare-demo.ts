import { getAppDatabase } from "@/lib/db/client";
import { DatabasePreparationError } from "@/lib/core/errors";
import { prepareDemoDatabase } from "@/lib/pipeline/prepare-demo";

async function main(): Promise<void> {
  try {
    const db = await getAppDatabase();
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
