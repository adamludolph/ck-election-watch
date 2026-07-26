import type { PGlite } from "@electric-sql/pglite";
import { PipelineError } from "@/lib/core/errors";
import { sha256, stableId } from "@/lib/core/hash";

type StageOptions = {
  stage: string;
  idempotencyKey: string;
  processorName: string;
  processorVersion: string;
  inputRefs: Record<string, unknown>;
  now: string;
};

type ExistingStageRow = {
  output_refs: string;
};

export async function runStage<T extends Record<string, unknown>>(
  db: PGlite,
  options: StageOptions,
  execute: () => Promise<T>,
): Promise<T> {
  const existing = await db.query<ExistingStageRow>(
    `SELECT output_refs::text AS output_refs
       FROM stage_runs
      WHERE stage = $1 AND idempotency_key = $2 AND status = 'succeeded'`,
    [options.stage, options.idempotencyKey],
  );
  if (existing.rows[0]) {
    return JSON.parse(existing.rows[0].output_refs) as T;
  }

  const attempts = await db.query<{ next_attempt: number }>(
    `SELECT COALESCE(MAX(attempt), 0) + 1 AS next_attempt
       FROM stage_runs
      WHERE stage = $1 AND idempotency_key = $2`,
    [options.stage, options.idempotencyKey],
  );
  const attempt = Number(attempts.rows[0]?.next_attempt ?? 1);
  const id = stableId(
    "stage",
    options.stage,
    options.idempotencyKey,
    String(attempt),
  );
  const configSha256 = sha256(
    `${options.processorName}\u001f${options.processorVersion}`,
  );

  await db.query(
    `INSERT INTO stage_runs (
       id, stage, idempotency_key, attempt, processor_name, processor_version,
       config_sha256, input_refs, status, started_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'running', $9)`,
    [
      id,
      options.stage,
      options.idempotencyKey,
      attempt,
      options.processorName,
      options.processorVersion,
      configSha256,
      JSON.stringify(options.inputRefs),
      options.now,
    ],
  );

  await db.exec("BEGIN");
  try {
    const output = await execute();
    await db.query(
      `UPDATE stage_runs
          SET status = 'succeeded', output_refs = $1::jsonb, completed_at = $2
        WHERE id = $3`,
      [JSON.stringify(output), options.now, id],
    );
    await db.exec("COMMIT");
    return output;
  } catch (error) {
    await db.exec("ROLLBACK");
    const code = error instanceof PipelineError ? error.code : "unexpected";
    const message =
      error instanceof Error ? error.message : "Unknown stage failure";
    await db.query(
      `UPDATE stage_runs
          SET status = 'failed', error_code = $1, error_message = $2,
              completed_at = $3
        WHERE id = $4`,
      [code, message.slice(0, 500), options.now, id],
    );
    throw error;
  }
}
