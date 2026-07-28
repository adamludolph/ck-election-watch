import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EditorialReplayConflictError,
  EditorialRecordNotFoundError,
  EditorialSubjectChangedError,
  EditorialTransitionConflictError,
  PublicationPolicyError,
} from "@/lib/core/errors";
import { createMemoryDatabase } from "@/lib/db/client";
import {
  getReviewQueue,
  getReviewStatement,
} from "@/lib/editorial/queries";
import { performEditorialAction } from "@/lib/editorial/workflow";
import { prepareDemoDatabase } from "@/lib/pipeline/prepare-demo";
import { getPublicCandidateRecord } from "@/lib/publication/public";

let db: PGlite;
let statementIds: Record<string, string>;

const at = (value: string) => () => value;

type SubjectMutation = {
  name: string;
  mutate: (database: PGlite, statementId: string) => Promise<void>;
};

const reviewSubjectMutations: SubjectMutation[] = [
  {
    name: "statement summary",
    mutate: async (database, statementId) => {
      await database.query(
        "UPDATE statements SET summary = summary || ' changed' WHERE id = $1",
        [statementId],
      );
    },
  },
  {
    name: "statement attribution",
    mutate: async (database, statementId) => {
      await database.query(
        "UPDATE statements SET attribution_type = 'campaign' WHERE id = $1",
        [statementId],
      );
    },
  },
  {
    name: "issue identity",
    mutate: async (database, statementId) => {
      const issue = await database.query<{
        id: string;
        slug: string;
        label: string;
      }>(
        `SELECT i.id, i.slug, i.label
           FROM statement_issues si
           JOIN issues i ON i.id = si.issue_id
          WHERE si.statement_id = $1
          LIMIT 1`,
        [statementId],
      );
      const original = issue.rows[0];
      await database.query(
        "UPDATE issues SET slug = slug || '-original' WHERE id = $1",
        [original.id],
      );
      await database.query(
        "INSERT INTO issues (id, slug, label) VALUES ($1, $2, $3)",
        ["issue_mutated_identity", original.slug, original.label],
      );
      await database.query(
        "UPDATE statement_issues SET issue_id = $1 WHERE statement_id = $2 AND issue_id = $3",
        ["issue_mutated_identity", statementId, original.id],
      );
    },
  },
  {
    name: "issue slug",
    mutate: async (database, statementId) => {
      await database.query(
        `UPDATE issues
            SET slug = slug || '-changed'
          WHERE id IN (
            SELECT issue_id FROM statement_issues WHERE statement_id = $1
          )`,
        [statementId],
      );
    },
  },
  {
    name: "issue label",
    mutate: async (database, statementId) => {
      await database.query(
        `UPDATE issues
            SET label = label || ' changed'
          WHERE id IN (
            SELECT issue_id FROM statement_issues WHERE statement_id = $1
          )`,
        [statementId],
      );
    },
  },
  {
    name: "candidacy identity",
    mutate: async (database, statementId) => {
      const candidacy = await database.query<{
        id: string;
        election_id: string;
        office_id: string;
        slug: string;
        status: string;
      }>(
        `SELECT c.id, c.election_id, c.office_id, c.slug, c.status
           FROM statements st
           JOIN candidacies c ON c.id = st.candidacy_id
          WHERE st.id = $1`,
        [statementId],
      );
      const original = candidacy.rows[0];
      await database.query(
        "UPDATE candidacies SET slug = slug || '-original' WHERE id = $1",
        [original.id],
      );
      await database.query(
        "INSERT INTO people (id, display_name) VALUES ($1, $2)",
        ["person_mutated_candidacy", "Mutated Fixture Person"],
      );
      await database.query(
        `INSERT INTO candidacies (
           id, election_id, office_id, person_id, official_person_key, slug, status
         ) VALUES ($1, $2, $3, $4, NULL, $5, $6)`,
        [
          "candidacy_mutated_identity",
          original.election_id,
          original.office_id,
          "person_mutated_candidacy",
          original.slug,
          original.status,
        ],
      );
      await database.query(
        "UPDATE statements SET candidacy_id = $1 WHERE id = $2",
        ["candidacy_mutated_identity", statementId],
      );
    },
  },
  {
    name: "candidacy slug",
    mutate: async (database, statementId) => {
      await database.query(
        `UPDATE candidacies
            SET slug = slug || '-changed'
          WHERE id = (SELECT candidacy_id FROM statements WHERE id = $1)`,
        [statementId],
      );
    },
  },
  {
    name: "evidence quote",
    mutate: async (database, statementId) => {
      await database.query(
        "UPDATE evidence SET quote = quote || ' changed' WHERE statement_id = $1",
        [statementId],
      );
    },
  },
  {
    name: "evidence offset",
    mutate: async (database, statementId) => {
      await database.query(
        "UPDATE evidence SET start_offset = start_offset + 1 WHERE statement_id = $1",
        [statementId],
      );
    },
  },
  {
    name: "normalized block identity",
    mutate: async (database, statementId) => {
      const block = await database.query<{ id: string }>(
        "SELECT normalized_block_id AS id FROM evidence WHERE statement_id = $1",
        [statementId],
      );
      await database.query(
        `INSERT INTO normalized_blocks (
           id, snapshot_id, ordinal, block_type, text, text_sha256
         )
         SELECT $1, snapshot_id, ordinal + 1000, block_type, text, text_sha256
           FROM normalized_blocks
          WHERE id = $2`,
        ["block_mutated_identity", block.rows[0].id],
      );
      await database.query(
        "UPDATE evidence SET normalized_block_id = $1 WHERE statement_id = $2",
        ["block_mutated_identity", statementId],
      );
    },
  },
  {
    name: "normalized block text",
    mutate: async (database, statementId) => {
      await database.query(
        `UPDATE normalized_blocks
            SET text = text || ' changed'
          WHERE id = (
            SELECT normalized_block_id FROM evidence WHERE statement_id = $1
          )`,
        [statementId],
      );
    },
  },
  {
    name: "normalized block digest",
    mutate: async (database, statementId) => {
      await database.query(
        `UPDATE normalized_blocks
            SET text_sha256 = repeat('0', 64)
          WHERE id = (
            SELECT normalized_block_id FROM evidence WHERE statement_id = $1
          )`,
        [statementId],
      );
    },
  },
  {
    name: "snapshot identity",
    mutate: async (database, statementId) => {
      const snapshot = await database.query<{ id: string }>(
        `SELECT nb.snapshot_id AS id
           FROM evidence e
           JOIN normalized_blocks nb ON nb.id = e.normalized_block_id
          WHERE e.statement_id = $1`,
        [statementId],
      );
      await database.query(
        `INSERT INTO sources (
           id, candidacy_id, source_type, title, canonical_url,
           attribution_policy, active
         )
         SELECT $1, candidacy_id, source_type, title,
                canonical_url || '/identity-copy', attribution_policy, active
           FROM sources
          WHERE id = (
            SELECT source_id FROM source_snapshots WHERE id = $2
          )`,
        ["source_mutated_snapshot_identity", snapshot.rows[0].id],
      );
      await database.query(
        `INSERT INTO source_snapshots (
           id, source_id, captured_at, original_url, canonical_url,
           content_type, encoding, raw_content, byte_length, content_sha256
         )
         SELECT $1, $2, captured_at, original_url, canonical_url,
                content_type, encoding, raw_content, byte_length, content_sha256
           FROM source_snapshots
          WHERE id = $3`,
        [
          "snapshot_mutated_identity",
          "source_mutated_snapshot_identity",
          snapshot.rows[0].id,
        ],
      );
      await database.query(
        `UPDATE normalized_blocks
            SET snapshot_id = $1
          WHERE id = (
            SELECT normalized_block_id FROM evidence WHERE statement_id = $2
          )`,
        ["snapshot_mutated_identity", statementId],
      );
      await database.query(
        `UPDATE extraction_runs
            SET snapshot_id = $1
          WHERE id = (
            SELECT extraction_run_id FROM statements WHERE id = $2
          )`,
        ["snapshot_mutated_identity", statementId],
      );
    },
  },
  {
    name: "snapshot digest",
    mutate: async (database, statementId) => {
      await database.query(
        `UPDATE source_snapshots
            SET content_sha256 = repeat('0', 64)
          WHERE id = (
            SELECT nb.snapshot_id
              FROM evidence e
              JOIN normalized_blocks nb ON nb.id = e.normalized_block_id
             WHERE e.statement_id = $1
          )`,
        [statementId],
      );
    },
  },
  {
    name: "source title",
    mutate: async (database, statementId) => {
      await database.query(
        `UPDATE sources
            SET title = title || ' changed'
          WHERE id = (
            SELECT ss.source_id
              FROM evidence e
              JOIN normalized_blocks nb ON nb.id = e.normalized_block_id
              JOIN source_snapshots ss ON ss.id = nb.snapshot_id
             WHERE e.statement_id = $1
          )`,
        [statementId],
      );
    },
  },
  {
    name: "source original URL",
    mutate: async (database, statementId) => {
      await database.query(
        `UPDATE source_snapshots
            SET original_url = 'https://example.invalid/changed-source'
          WHERE id = (
            SELECT nb.snapshot_id
              FROM evidence e
              JOIN normalized_blocks nb ON nb.id = e.normalized_block_id
             WHERE e.statement_id = $1
          )`,
        [statementId],
      );
    },
  },
  {
    name: "source capture time",
    mutate: async (database, statementId) => {
      await database.query(
        `UPDATE source_snapshots
            SET captured_at = captured_at + interval '1 second'
          WHERE id = (
            SELECT nb.snapshot_id
              FROM evidence e
              JOIN normalized_blocks nb ON nb.id = e.normalized_block_id
             WHERE e.statement_id = $1
          )`,
        [statementId],
      );
    },
  },
  {
    name: "extraction identity",
    mutate: async (database, statementId) => {
      await database.query(
        "UPDATE statements SET extraction_item_id = extraction_item_id || '-changed' WHERE id = $1",
        [statementId],
      );
    },
  },
  {
    name: "source attribution relationship",
    mutate: async (database, statementId) => {
      await database.query(
        `UPDATE sources
            SET attribution_policy = 'third_party'
          WHERE id = (
            SELECT ss.source_id
              FROM evidence e
              JOIN normalized_blocks nb ON nb.id = e.normalized_block_id
              JOIN source_snapshots ss ON ss.id = nb.snapshot_id
             WHERE e.statement_id = $1
          )`,
        [statementId],
      );
    },
  },
];

const publishPolicyMutations: SubjectMutation[] = [
  {
    name: "ineligible attribution",
    mutate: async (database, statementId) => {
      await database.query(
        "UPDATE statements SET attribution_type = 'campaign' WHERE id = $1",
        [statementId],
      );
    },
  },
  {
    name: "snapshot bytes",
    mutate: async (database, statementId) => {
      await database.query(
        `UPDATE source_snapshots
            SET raw_content = decode('00', 'hex')
          WHERE id = (
            SELECT nb.snapshot_id
              FROM evidence e
              JOIN normalized_blocks nb ON nb.id = e.normalized_block_id
             WHERE e.statement_id = $1
          )`,
        [statementId],
      );
    },
  },
  {
    name: "normalized block text",
    mutate: async (database, statementId) => {
      await database.query(
        `UPDATE normalized_blocks
            SET text = text || ' changed'
          WHERE id = (
            SELECT normalized_block_id FROM evidence WHERE statement_id = $1
          )`,
        [statementId],
      );
    },
  },
  {
    name: "quote offsets",
    mutate: async (database, statementId) => {
      await database.query(
        "UPDATE evidence SET start_offset = start_offset + 1 WHERE statement_id = $1",
        [statementId],
      );
    },
  },
];

beforeEach(async () => {
  db = await createMemoryDatabase();
  statementIds = (await prepareDemoDatabase(db)).statementIds;
});

afterEach(async () => {
  await db.close();
});

describe("editorial workflow", () => {
  it("prepares five deterministic statements across the required queue phases", async () => {
    const queue = await getReviewQueue(db, "all");
    expect(queue.counts).toEqual({
      all: 5,
      needs_review: 2,
      changes_requested: 0,
      ready_to_approve: 1,
      approved_unpublished: 1,
      published: 1,
      rejected: 0,
      withdrawn: 0,
    });
    expect(queue.records).toHaveLength(5);
  });

  it("runs review, approval, publication, and terminal unpublication atomically", async () => {
    const statementId = statementIds["statement-roads"];
    await performEditorialAction(
      db,
      {
        action: "reviewed_ready",
        statementId,
        requestId: "test:roads:review",
        operatorRef: "fixture:test-editor",
        expectedPhase: "needs_review",
        note: "PRIVATE_SENTINEL_LIFECYCLE_NOTE",
      },
      at("2026-07-24T17:00:00.000Z"),
    );
    await performEditorialAction(
      db,
      {
        action: "approved",
        statementId,
        requestId: "test:roads:approve",
        operatorRef: "fixture:test-editor",
        expectedPhase: "ready_to_approve",
        reason: "PRIVATE_SENTINEL_LIFECYCLE_APPROVAL",
      },
      at("2026-07-24T17:01:00.000Z"),
    );
    const published = await performEditorialAction(
      db,
      {
        action: "published",
        statementId,
        requestId: "test:roads:publish",
        operatorRef: "fixture:test-publisher",
        expectedPhase: "approved_unpublished",
        reason: "PRIVATE_SENTINEL_LIFECYCLE_PUBLICATION",
      },
      at("2026-07-24T17:02:00.000Z"),
    );
    expect(published.phase).toBe("published");
    const visible = await getPublicCandidateRecord(db, "demo-candidate");
    expect(JSON.stringify(visible)).toContain("preventive road maintenance");
    expect(JSON.stringify(visible)).not.toContain("PRIVATE_SENTINEL");

    const withdrawn = await performEditorialAction(
      db,
      {
        action: "unpublished",
        statementId,
        requestId: "test:roads:unpublish",
        operatorRef: "fixture:test-publisher",
        expectedPhase: "published",
        reason: "PRIVATE_SENTINEL_LIFECYCLE_WITHDRAWAL",
      },
      at("2026-07-24T17:03:00.000Z"),
    );
    expect(withdrawn.phase).toBe("withdrawn");
    const detail = await getReviewStatement(db, statementId);
    expect(detail.phase).toBe("withdrawn");
    expect(detail.history.at(-1)).toMatchObject({
      eventTypes: ["unpublished", "withdrawn"],
      reason: "PRIVATE_SENTINEL_LIFECYCLE_WITHDRAWAL",
    });
    const hidden = await getPublicCandidateRecord(db, "demo-candidate");
    expect(JSON.stringify(hidden)).not.toContain("preventive road maintenance");
    expect(JSON.stringify(hidden)).not.toContain("PRIVATE_SENTINEL");

    await db.query(
      "UPDATE publications SET withdrawn_at = NULL WHERE statement_id = $1",
      [statementId],
    );
    const stillHidden = await getPublicCandidateRecord(
      db,
      "demo-candidate",
    );
    expect(JSON.stringify(stillHidden)).not.toContain(
      "preventive road maintenance",
    );
    await expect(
      performEditorialAction(
        db,
        {
          action: "published",
          statementId,
          requestId: "test:roads:republish",
          operatorRef: "fixture:test-publisher",
          expectedPhase: "withdrawn",
        },
        at("2026-07-24T17:04:00.000Z"),
      ),
    ).rejects.toThrow(EditorialTransitionConflictError);
  });

  it("records changes requested and terminal rejection without public leakage", async () => {
    const statementId = statementIds["statement-transit"];
    await performEditorialAction(
      db,
      {
        action: "reviewed_changes_requested",
        statementId,
        requestId: "test:transit:changes",
        operatorRef: "fixture:test-editor",
        expectedPhase: "needs_review",
        reason: "PRIVATE_SENTINEL_TRANSIT_CHANGES",
      },
      at("2026-07-24T17:10:00.000Z"),
    );
    await performEditorialAction(
      db,
      {
        action: "rejected",
        statementId,
        requestId: "test:transit:reject",
        operatorRef: "fixture:test-editor",
        expectedPhase: "changes_requested",
        reason: "PRIVATE_SENTINEL_TRANSIT_REJECTION",
      },
      at("2026-07-24T17:11:00.000Z"),
    );
    const queue = await getReviewQueue(db, "rejected");
    expect(queue.records.map((record) => record.statementId)).toEqual([
      statementId,
    ]);
    const candidate = await getPublicCandidateRecord(db, "demo-candidate");
    expect(JSON.stringify(candidate)).not.toContain("peak-hour bus");
    expect(JSON.stringify(candidate)).not.toContain("PRIVATE_SENTINEL");
  });

  it("returns exact replay and rejects a changed private reason without storing plaintext in stage refs", async () => {
    const statementId = statementIds["statement-clinic-reports"];
    const input = {
      action: "approved" as const,
      statementId,
      requestId: "test:clinic:approve",
      operatorRef: "fixture:test-editor",
      expectedPhase: "ready_to_approve" as const,
      reason: "PRIVATE_SENTINEL_REPLAY_ORIGINAL",
    };
    const first = await performEditorialAction(
      db,
      input,
      at("2026-07-24T17:20:00.000Z"),
    );
    const replay = await performEditorialAction(
      db,
      input,
      at("2026-07-24T18:20:00.000Z"),
    );
    expect(replay).toEqual(first);
    await expect(
      performEditorialAction(
        db,
        { ...input, reason: "PRIVATE_SENTINEL_REPLAY_CHANGED" },
        at("2026-07-24T18:21:00.000Z"),
      ),
    ).rejects.toThrow(EditorialReplayConflictError);
    const stage = await db.query<{ input_refs: string }>(
      `SELECT input_refs::text AS input_refs
         FROM stage_runs
        WHERE stage = 'editorial:approved'
          AND idempotency_key = $1
          AND status = 'succeeded'`,
      [input.requestId],
    );
    expect(stage.rows[0].input_refs).not.toContain("PRIVATE_SENTINEL");
    expect(stage.rows[0].input_refs).toContain("inputFingerprintSha256");
  });

  it.each(reviewSubjectMutations)(
    "blocks approval after $name changes",
    async ({ mutate }) => {
    const roads = statementIds["statement-roads"];
    await performEditorialAction(
      db,
      {
        action: "reviewed_ready",
        statementId: roads,
        requestId: "test:subject:review",
        operatorRef: "fixture:test-editor",
        expectedPhase: "needs_review",
      },
      at("2026-07-24T17:30:00.000Z"),
    );
      await mutate(db, roads);
      let blocked: unknown;
      try {
        await performEditorialAction(
          db,
          {
            action: "approved",
            statementId: roads,
            requestId: "test:subject:approve",
            operatorRef: "fixture:test-editor",
            expectedPhase: "ready_to_approve",
            reason: "Digest must match.",
          },
          at("2026-07-24T17:31:00.000Z"),
        );
      } catch (error) {
        blocked = error;
      }
      expect(
        blocked instanceof EditorialSubjectChangedError ||
          blocked instanceof PublicationPolicyError,
      ).toBe(true);
      const unchanged = await db.query<{
        status: string;
        events: number;
      }>(
        `SELECT
           status,
           (SELECT COUNT(*)::integer
              FROM statement_editorial_events
             WHERE statement_id = $1) AS events
         FROM statements
        WHERE id = $1`,
        [roads],
      );
      expect(unchanged.rows[0]).toEqual({
        status: "draft",
        events: 1,
      });
    },
  );

  it.each(publishPolicyMutations)(
    "revalidates $name before publication",
    async ({ mutate }) => {
      const tracker = statementIds["statement-road-tracker"];
      await mutate(db, tracker);
      await expect(
        performEditorialAction(
          db,
          {
            action: "published",
            statementId: tracker,
            requestId: "test:policy:publish",
            operatorRef: "fixture:test-publisher",
            expectedPhase: "approved_unpublished",
          },
          at("2026-07-24T17:32:00.000Z"),
        ),
      ).rejects.toThrow(PublicationPolicyError);
      const unchanged = await db.query<{
        status: string;
        publications: number;
        events: number;
      }>(
        `SELECT
           status,
           (SELECT COUNT(*)::integer
              FROM publications
             WHERE statement_id = $1) AS publications,
           (SELECT COUNT(*)::integer
              FROM publication_events pe
              JOIN publications p ON p.id = pe.publication_id
             WHERE p.statement_id = $1
               AND pe.event_type = 'published') AS events
         FROM statements
        WHERE id = $1`,
        [tracker],
      );
      expect(unchanged.rows[0]).toEqual({
        status: "approved",
        publications: 0,
        events: 0,
      });
    },
  );

  it("serializes concurrent duplicate review and rejects time regression", async () => {
    const roads = statementIds["statement-roads"];
    const input = {
      action: "reviewed_ready" as const,
      statementId: roads,
      requestId: "test:concurrent:review",
      operatorRef: "fixture:test-editor",
      expectedPhase: "needs_review" as const,
    };
    const [first, second] = await Promise.all([
      performEditorialAction(
        db,
        input,
        at("2026-07-24T17:40:00.000Z"),
      ),
      performEditorialAction(
        db,
        input,
        at("2026-07-24T17:40:00.000Z"),
      ),
    ]);
    expect(second).toEqual(first);
    const count = await db.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
         FROM statement_editorial_events
        WHERE statement_id = $1 AND event_type = 'reviewed_ready'`,
      [roads],
    );
    expect(count.rows[0].count).toBe(1);

    const clinic = statementIds["statement-clinic-reports"];
    await expect(
      performEditorialAction(
        db,
        {
          action: "approved",
          statementId: clinic,
          requestId: "test:time:approve",
          operatorRef: "fixture:test-editor",
          expectedPhase: "ready_to_approve",
          reason: "Time regression test.",
        },
        at("2026-07-24T16:08:00.000Z"),
      ),
    ).rejects.toThrow(EditorialTransitionConflictError);
  });

  it("keeps public output identical when private drafts and history change", async () => {
    const before = await getPublicCandidateRecord(db, "demo-candidate");
    await db.query(
      "UPDATE statements SET summary = 'PRIVATE_SENTINEL_DRAFT_MUTATION' WHERE status = 'draft'",
    );
    await performEditorialAction(
      db,
      {
        action: "reviewed_ready",
        statementId: statementIds["statement-roads"],
        requestId: "test:private-history-mutation",
        operatorRef: "fixture:private-editor",
        expectedPhase: "needs_review",
        note: "PRIVATE_SENTINEL_HISTORY_NOTE",
      },
      at("2026-07-24T17:00:00.000Z"),
    );
    const privateHistory = await db.query<{ note: string }>(
      `SELECT note
         FROM statement_editorial_events
        WHERE request_id = $1`,
      ["test:private-history-mutation"],
    );
    expect(privateHistory.rows).toEqual([
      { note: "PRIVATE_SENTINEL_HISTORY_NOTE" },
    ]);
    const after = await getPublicCandidateRecord(db, "demo-candidate");
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain("PRIVATE_SENTINEL");
  });

  it("keeps action-scoped history separate when request IDs are reused", async () => {
    const statementId = statementIds["statement-roads"];
    const requestId = "test:shared-request-id";
    await performEditorialAction(
      db,
      {
        action: "reviewed_ready",
        statementId,
        requestId,
        operatorRef: "fixture:first-editor",
        expectedPhase: "needs_review",
        note: "First decision.",
      },
      at("2026-07-24T18:10:00.000Z"),
    );
    await performEditorialAction(
      db,
      {
        action: "approved",
        statementId,
        requestId,
        operatorRef: "fixture:second-editor",
        expectedPhase: "ready_to_approve",
        reason: "Second decision.",
      },
      at("2026-07-24T18:11:00.000Z"),
    );

    const detail = await getReviewStatement(db, statementId);
    expect(detail.history.filter((item) => item.requestId === requestId))
      .toEqual([
        expect.objectContaining({
          eventTypes: ["reviewed_ready"],
          operatorRef: "fixture:first-editor",
          note: "First decision.",
        }),
        expect.objectContaining({
          eventTypes: ["approved"],
          operatorRef: "fixture:second-editor",
          reason: "Second decision.",
        }),
      ]);
  });

  it("reports a missing review record explicitly", async () => {
    await expect(getReviewStatement(db, "statement_missing")).rejects.toThrow(
      EditorialRecordNotFoundError,
    );
  });
});
