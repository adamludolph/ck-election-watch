import type { PGlite, Transaction } from "@electric-sql/pglite";
import { PipelineError } from "@/lib/core/errors";
import { sha256, stableId } from "@/lib/core/hash";

type StageOptions = {
  stage: string;
  idempotencyKey: string;
  processorName: string;
  processorVersion: string;
  inputRefs: Record<string, unknown>;
  now: string;
  validateReplay?: () => Promise<void>;
};

type ExistingStageRow = {
  output_refs: string;
};

const stageTails = new WeakMap<PGlite, Promise<unknown>>();

async function beginStageAttempt(
  db: PGlite,
  options: StageOptions,
): Promise<string> {
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
  return id;
}

async function failStageAttempt(
  db: PGlite,
  id: string,
  now: string,
  error: unknown,
): Promise<void> {
  const code = error instanceof PipelineError ? error.code : "unexpected";
  const message =
    error instanceof Error ? error.message : "Unknown stage failure";
  await db.query(
    `UPDATE stage_runs
        SET status = 'failed', error_code = $1, error_message = $2,
            completed_at = $3
      WHERE id = $4`,
    [code, message.slice(0, 500), now, id],
  );
}

async function serializeStage<T>(
  db: PGlite,
  execute: () => Promise<T>,
): Promise<T> {
  const prior = stageTails.get(db) ?? Promise.resolve();
  const current = prior.catch(() => undefined).then(execute);
  stageTails.set(db, current);
  try {
    return await current;
  } finally {
    if (stageTails.get(db) === current) {
      stageTails.delete(db);
    }
  }
}

export async function runStage<T extends Record<string, unknown>>(
  db: PGlite,
  options: StageOptions,
  execute: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return serializeStage(db, async () => {
    const existing = await db.query<ExistingStageRow>(
      `SELECT output_refs::text AS output_refs
         FROM stage_runs
        WHERE stage = $1 AND idempotency_key = $2 AND status = 'succeeded'`,
      [options.stage, options.idempotencyKey],
    );
    if (existing.rows[0]) {
      if (options.validateReplay) {
        try {
          await options.validateReplay();
        } catch (error) {
          const replayAttemptId = await beginStageAttempt(db, options);
          await failStageAttempt(db, replayAttemptId, options.now, error);
          throw error;
        }
      }
      return JSON.parse(existing.rows[0].output_refs) as T;
    }

    const id = await beginStageAttempt(db, options);

    try {
      return await db.transaction(async (tx) => {
        const output = await execute(tx);
        await tx.query(
          `UPDATE stage_runs
              SET status = 'succeeded', output_refs = $1::jsonb, completed_at = $2
            WHERE id = $3`,
          [JSON.stringify(output), options.now, id],
        );
        return output;
      });
    } catch (error) {
      await failStageAttempt(db, id, options.now, error);
      throw error;
    }
  });
}
