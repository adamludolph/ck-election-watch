import type { PGlite, Transaction } from "@electric-sql/pglite";
import { canonicalize } from "json-canonicalize";
import { z } from "zod";
import {
  EditorialInputError,
  EditorialRecordNotFoundError,
  EditorialReplayConflictError,
  EditorialSubjectChangedError,
  EditorialTransitionConflictError,
} from "@/lib/core/errors";
import { sha256, stableId } from "@/lib/core/hash";
import { loadEditorialSubject } from "@/lib/editorial/subject";
import {
  editorialActions,
  editorialPhases,
  type EditorialAction,
  type EditorialActionResult,
  type EditorialPhase,
} from "@/lib/editorial/types";
import { runStage } from "@/lib/pipeline/stage";
import { persistPublication } from "@/lib/publication/publish";

const optionalText = z
  .string()
  .trim()
  .max(500, "Enter 500 characters or fewer.")
  .optional()
  .transform((value) => (value ? value : undefined));

const actionInputSchema = z
  .object({
    action: z.enum(editorialActions),
    statementId: z.string().trim().min(1).max(200),
    requestId: z.string().trim().min(1).max(200),
    operatorRef: z.string().trim().min(1).max(100),
    expectedPhase: z.enum(editorialPhases),
    note: optionalText,
    reason: optionalText,
  })
  .superRefine((input, context) => {
    const reasonRequired = [
      "reviewed_changes_requested",
      "approved",
      "rejected",
      "unpublished",
    ].includes(input.action);
    if (reasonRequired && !input.reason) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "A reason is required for this action.",
      });
    }
    if (input.action !== "reviewed_ready" && input.note) {
      context.addIssue({
        code: "custom",
        path: ["note"],
        message: "A note is not accepted for this action.",
      });
    }
    if (
      ![
        "reviewed_changes_requested",
        "approved",
        "rejected",
        "published",
        "unpublished",
      ].includes(input.action) &&
      input.reason
    ) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "A reason is not accepted for this action.",
      });
    }
  });

export type EditorialActionInput = z.input<typeof actionInputSchema>;

type ParsedActionInput = z.output<typeof actionInputSchema>;

type QueryClient = Pick<PGlite, "query">;

type StatementRow = {
  id: string;
  status: string;
};

type EditorialEventRow = {
  id: string;
  event_type: string;
  input_fingerprint_sha256: string;
  review_subject_sha256: string;
  sequence: number;
  occurred_at: string;
};

type PublicationRow = {
  id: string;
  approved_editorial_event_id: string;
};

function parseInput(input: EditorialActionInput): ParsedActionInput {
  const parsed = actionInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new EditorialInputError(
      parsed.error.issues[0]?.message ?? "Editorial input is invalid.",
      parsed.error,
    );
  }
  return parsed.data;
}

function fingerprintInput(input: ParsedActionInput): string {
  return sha256(
    canonicalize({
      action: input.action,
      statementId: input.statementId,
      requestId: input.requestId,
      operatorRef: input.operatorRef,
      expectedPhase: input.expectedPhase,
      note: input.note ?? null,
      reason: input.reason ?? null,
    }),
  );
}

async function currentPhase(
  db: QueryClient,
  statement: StatementRow,
): Promise<EditorialPhase> {
  if (statement.status === "rejected") {
    return "rejected";
  }
  if (statement.status === "withdrawn") {
    return "withdrawn";
  }
  const active = await db.query<{ active: boolean; unpublished: boolean }>(
    `SELECT
       EXISTS (
         SELECT 1
           FROM active_publication_payloads
          WHERE statement_id = $1
       ) AS active,
       EXISTS (
         SELECT 1
           FROM publications p
           JOIN publication_events pe ON pe.publication_id = p.id
          WHERE p.statement_id = $1
            AND pe.event_type = 'unpublished'
       ) AS unpublished`,
    [statement.id],
  );
  if (statement.status === "approved") {
    if (active.rows[0]?.active) {
      return "published";
    }
    if (active.rows[0]?.unpublished) {
      throw new EditorialTransitionConflictError(
        "Approved statement has a prior unpublication.",
      );
    }
    return "approved_unpublished";
  }
  if (statement.status !== "draft") {
    throw new EditorialTransitionConflictError(
      `Unsupported statement status ${statement.status}.`,
    );
  }
  const latest = await db.query<{ event_type: string }>(
    `SELECT event_type
       FROM statement_editorial_events
      WHERE statement_id = $1
      ORDER BY sequence DESC
      LIMIT 1`,
    [statement.id],
  );
  if (latest.rows[0]?.event_type === "reviewed_ready") {
    return "ready_to_approve";
  }
  if (latest.rows[0]?.event_type === "reviewed_changes_requested") {
    return "changes_requested";
  }
  return "needs_review";
}

function expectedPhaseForAction(action: EditorialAction): EditorialPhase {
  switch (action) {
    case "reviewed_ready":
    case "reviewed_changes_requested":
      return "needs_review";
    case "approved":
      return "ready_to_approve";
    case "rejected":
      return "changes_requested";
    case "published":
      return "approved_unpublished";
    case "unpublished":
      return "published";
  }
}

function resultPhase(action: EditorialAction): EditorialPhase {
  switch (action) {
    case "reviewed_ready":
      return "ready_to_approve";
    case "reviewed_changes_requested":
      return "changes_requested";
    case "approved":
      return "approved_unpublished";
    case "rejected":
      return "rejected";
    case "published":
      return "published";
    case "unpublished":
      return "withdrawn";
  }
}

async function appendEditorialEvent(
  tx: Transaction,
  input: ParsedActionInput,
  options: {
    eventType: Exclude<EditorialAction, "published" | "unpublished"> | "withdrawn";
    fingerprint: string;
    subjectDigest: string;
    previousStatus: string;
    currentStatus: string;
    now: string;
  },
): Promise<string> {
  const sequenceResult = await tx.query<{ next_sequence: number }>(
    `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
       FROM statement_editorial_events
      WHERE statement_id = $1`,
    [input.statementId],
  );
  const sequence = Number(sequenceResult.rows[0]?.next_sequence ?? 1);
  const eventId = stableId(
    "editorial-event",
    input.statementId,
    options.eventType,
    input.requestId,
  );
  await tx.query(
    `INSERT INTO statement_editorial_events (
       id, statement_id, event_type, request_id, input_fingerprint_sha256,
       sequence, operator_ref, note, reason, previous_status, current_status,
       review_subject_sha256, occurred_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
     )`,
    [
      eventId,
      input.statementId,
      options.eventType,
      input.requestId,
      options.fingerprint,
      sequence,
      input.operatorRef,
      options.eventType === "reviewed_ready" ? (input.note ?? null) : null,
      options.eventType === "reviewed_ready" ? null : (input.reason ?? null),
      options.previousStatus,
      options.currentStatus,
      options.subjectDigest,
      options.now,
    ],
  );
  return eventId;
}

async function latestEditorialEvent(
  tx: Transaction,
  statementId: string,
  eventType: string,
): Promise<EditorialEventRow> {
  const result = await tx.query<EditorialEventRow>(
    `SELECT id, event_type, input_fingerprint_sha256, review_subject_sha256,
            sequence, occurred_at::text
       FROM statement_editorial_events
      WHERE statement_id = $1 AND event_type = $2
      ORDER BY sequence DESC
      LIMIT 1`,
    [statementId, eventType],
  );
  if (!result.rows[0]) {
    throw new EditorialTransitionConflictError(
      `Required ${eventType} decision is missing.`,
    );
  }
  return result.rows[0];
}

async function assertMonotonicTime(
  tx: Transaction,
  statementId: string,
  now: string,
): Promise<void> {
  const latest = await tx.query<{ occurred_at: string | null }>(
    `SELECT MAX(occurred_at)::text AS occurred_at
       FROM (
         SELECT occurred_at
           FROM statement_editorial_events
          WHERE statement_id = $1
         UNION ALL
         SELECT pe.occurred_at
           FROM publications p
           JOIN publication_events pe ON pe.publication_id = p.id
          WHERE p.statement_id = $1
       ) events`,
    [statementId],
  );
  if (
    latest.rows[0]?.occurred_at &&
    new Date(now).getTime() < new Date(latest.rows[0].occurred_at).getTime()
  ) {
    throw new EditorialTransitionConflictError(
      "Action time cannot precede existing history.",
    );
  }
}

async function validateReplay(
  db: PGlite,
  input: ParsedActionInput,
  fingerprint: string,
): Promise<void> {
  const result =
    input.action === "published" || input.action === "unpublished"
      ? await db.query<{ input_fingerprint_sha256: string }>(
          `SELECT pe.input_fingerprint_sha256
             FROM publication_events pe
             JOIN publications p ON p.id = pe.publication_id
            WHERE p.statement_id = $1
              AND pe.event_type = $2
              AND pe.request_id = $3`,
          [input.statementId, input.action, input.requestId],
        )
      : await db.query<{ input_fingerprint_sha256: string }>(
          `SELECT input_fingerprint_sha256
             FROM statement_editorial_events
            WHERE statement_id = $1
              AND event_type = $2
              AND request_id = $3`,
          [input.statementId, input.action, input.requestId],
        );
  if (
    !result.rows[0] ||
    result.rows[0].input_fingerprint_sha256 !== fingerprint
  ) {
    throw new EditorialReplayConflictError(
      "Request ID was already used with different editorial input.",
    );
  }
}

async function executeInTransaction(
  tx: Transaction,
  input: ParsedActionInput,
  fingerprint: string,
  now: string,
): Promise<EditorialActionResult> {
  const locked = await tx.query<StatementRow>(
    "SELECT id, status FROM statements WHERE id = $1 FOR UPDATE",
    [input.statementId],
  );
  const statement = locked.rows[0];
  if (!statement) {
    throw new EditorialRecordNotFoundError();
  }
  const phase = await currentPhase(tx, statement);
  const requiredPhase = expectedPhaseForAction(input.action);
  if (input.expectedPhase !== phase || phase !== requiredPhase) {
    throw new EditorialTransitionConflictError(
      `Action ${input.action} requires ${requiredPhase}; current phase is ${phase}.`,
    );
  }
  await assertMonotonicTime(tx, input.statementId, now);

  if (input.action === "unpublished") {
    const publicationResult = await tx.query<PublicationRow>(
      `SELECT p.id, published.approved_editorial_event_id
         FROM publications p
         JOIN publication_events published
           ON published.publication_id = p.id
          AND published.event_type = 'published'
        WHERE p.statement_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM publication_events unpublished
             WHERE unpublished.publication_id = p.id
               AND unpublished.event_type = 'unpublished'
          )`,
      [input.statementId],
    );
    const publication = publicationResult.rows[0];
    if (!publication) {
      throw new EditorialTransitionConflictError(
        "Statement has no active publication.",
      );
    }
    const approved = await latestEditorialEvent(
      tx,
      input.statementId,
      "approved",
    );
    const publicationEventId = stableId(
      "publication-event",
      publication.id,
      input.action,
      input.requestId,
    );
    await tx.query(
      `INSERT INTO publication_events (
         id, publication_id, event_type, request_id,
         input_fingerprint_sha256, operator_ref, reason, occurred_at
       ) VALUES ($1, $2, 'unpublished', $3, $4, $5, $6, $7)`,
      [
        publicationEventId,
        publication.id,
        input.requestId,
        fingerprint,
        input.operatorRef,
        input.reason,
        now,
      ],
    );
    await tx.query(
      `UPDATE publications
          SET withdrawn_at = $1, withdrawal_reason = $2
        WHERE id = $3`,
      [now, input.reason, publication.id],
    );
    await tx.query(
      "UPDATE statements SET status = 'withdrawn' WHERE id = $1",
      [input.statementId],
    );
    const editorialEventId = await appendEditorialEvent(tx, input, {
      eventType: "withdrawn",
      fingerprint,
      subjectDigest: approved.review_subject_sha256,
      previousStatus: "approved",
      currentStatus: "withdrawn",
      now,
    });
    return {
      statementId: input.statementId,
      action: input.action,
      phase: "withdrawn",
      eventIds: [publicationEventId, editorialEventId],
      publicationId: publication.id,
    };
  }

  const subject = await loadEditorialSubject(tx, input.statementId);
  if (input.action === "reviewed_ready") {
    const eventId = await appendEditorialEvent(tx, input, {
      eventType: input.action,
      fingerprint,
      subjectDigest: subject.digest,
      previousStatus: "draft",
      currentStatus: "draft",
      now,
    });
    return {
      statementId: input.statementId,
      action: input.action,
      phase: "ready_to_approve",
      eventIds: [eventId],
    };
  }
  if (input.action === "reviewed_changes_requested") {
    const eventId = await appendEditorialEvent(tx, input, {
      eventType: input.action,
      fingerprint,
      subjectDigest: subject.digest,
      previousStatus: "draft",
      currentStatus: "draft",
      now,
    });
    return {
      statementId: input.statementId,
      action: input.action,
      phase: "changes_requested",
      eventIds: [eventId],
    };
  }
  if (input.action === "approved") {
    const reviewed = await latestEditorialEvent(
      tx,
      input.statementId,
      "reviewed_ready",
    );
    if (reviewed.review_subject_sha256 !== subject.digest) {
      throw new EditorialSubjectChangedError(
        "Evidence changed after review; review the statement again.",
      );
    }
    await tx.query(
      "UPDATE statements SET status = 'approved', approved_at = $1 WHERE id = $2",
      [now, input.statementId],
    );
    const eventId = await appendEditorialEvent(tx, input, {
      eventType: input.action,
      fingerprint,
      subjectDigest: subject.digest,
      previousStatus: "draft",
      currentStatus: "approved",
      now,
    });
    return {
      statementId: input.statementId,
      action: input.action,
      phase: "approved_unpublished",
      eventIds: [eventId],
    };
  }
  if (input.action === "rejected") {
    const reviewed = await latestEditorialEvent(
      tx,
      input.statementId,
      "reviewed_changes_requested",
    );
    if (reviewed.review_subject_sha256 !== subject.digest) {
      throw new EditorialSubjectChangedError(
        "Evidence changed after review; the rejection was not recorded.",
      );
    }
    await tx.query(
      "UPDATE statements SET status = 'rejected', approved_at = NULL WHERE id = $1",
      [input.statementId],
    );
    const eventId = await appendEditorialEvent(tx, input, {
      eventType: input.action,
      fingerprint,
      subjectDigest: subject.digest,
      previousStatus: "draft",
      currentStatus: "rejected",
      now,
    });
    return {
      statementId: input.statementId,
      action: input.action,
      phase: "rejected",
      eventIds: [eventId],
    };
  }

  const approved = await latestEditorialEvent(
    tx,
    input.statementId,
    "approved",
  );
  if (approved.review_subject_sha256 !== subject.digest) {
    throw new EditorialSubjectChangedError(
      "Approved evidence changed; publication was blocked.",
    );
  }
  const publication = await persistPublication(tx, {
    statementId: input.statementId,
    payload: subject.payload,
    now,
  });
  const publicationEventId = stableId(
    "publication-event",
    publication.publicationId,
    input.action,
    input.requestId,
  );
  await tx.query(
    `INSERT INTO publication_events (
       id, publication_id, event_type, request_id, input_fingerprint_sha256,
       approved_editorial_event_id, operator_ref, reason, occurred_at
     ) VALUES ($1, $2, 'published', $3, $4, $5, $6, $7, $8)`,
    [
      publicationEventId,
      publication.publicationId,
      input.requestId,
      fingerprint,
      approved.id,
      input.operatorRef,
      input.reason ?? null,
      now,
    ],
  );
  return {
    statementId: input.statementId,
    action: input.action,
    phase: resultPhase(input.action),
    eventIds: [publicationEventId],
    publicationId: publication.publicationId,
  };
}

export async function performEditorialAction(
  db: PGlite,
  rawInput: EditorialActionInput,
  clock: () => string = () => new Date().toISOString(),
): Promise<EditorialActionResult> {
  const input = parseInput(rawInput);
  const fingerprint = fingerprintInput(input);
  const now = clock();
  return runStage(
    db,
    {
      stage: `editorial:${input.action}`,
      idempotencyKey: input.requestId,
      processorName: "editorial-workflow",
      processorVersion: "1",
      inputRefs: {
        statementId: input.statementId,
        action: input.action,
        requestId: input.requestId,
        inputFingerprintSha256: fingerprint,
      },
      now,
      validateReplay: () => validateReplay(db, input, fingerprint),
    },
    (tx) => executeInTransaction(tx, input, fingerprint, now),
  );
}
