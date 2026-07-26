import type { PGlite, Transaction } from "@electric-sql/pglite";
import { z } from "zod";
import {
  DiscoverySourceConflictError,
  DiscoveryTransitionError,
  DiscoveryValidationError,
} from "@/lib/core/errors";
import { sha256, stableId } from "@/lib/core/hash";
import { canonicalPublicWebUrl } from "@/lib/core/url";
import { runStage } from "@/lib/pipeline/stage";

type QueryClient = Pick<PGlite, "query">;

const slugSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const boundedText = (max: number) => z.string().trim().min(1).max(max);

const ownershipInputSchema = z
  .object({
    schemaVersion: z.literal("1"),
    candidacy: z
      .object({
        kind: z.literal("official-candidacy-link"),
        officialImport: z
          .object({
            sourceUrl: z.url(),
            observedAt: z.iso.datetime(),
          })
          .strict(),
        upstreamKey: boundedText(128),
      })
      .strict(),
    sourceAssociation: z
      .object({
        kind: z.literal("candidate-page-self-identification"),
        observedUrl: z.url(),
        observedAt: z.iso.datetime(),
        excerpt: boundedText(500),
      })
      .strict(),
    note: boundedText(500).optional(),
  })
  .strict();

export const discoveryFixtureSchema = z
  .object({
    schemaVersion: z.literal("1"),
    run: z
      .object({
        municipalitySlug: slugSchema,
        electionDate: z.iso.date(),
        method: z.literal("manual_fixture"),
        methodVersion: boundedText(50),
        startedAt: z.iso.datetime(),
        completedAt: z.iso.datetime(),
      })
      .strict(),
    results: z
      .array(
        z
          .object({
            candidacyUpstreamKey: boundedText(128),
            observedUrl: z.url(),
            canonicalUrl: z.url(),
            proposedTitle: boundedText(200),
            sourceType: z.literal("website"),
            observedAt: z.iso.datetime(),
            ownershipEvidence: ownershipInputSchema,
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();

export type DiscoveryFixture = z.infer<typeof discoveryFixtureSchema>;

export type DiscoveryRecordResult = {
  discoveryRunId: string;
  discoveredSourceIds: string[];
};

export type DiscoveryDecisionResult = {
  discoveredSourceId: string;
  status: "accepted" | "rejected";
  sourceId: string | null;
};

function exactUrl(value: string): string {
  try {
    return canonicalPublicWebUrl(value);
  } catch (error) {
    throw new DiscoveryValidationError(
      "Discovery fixture contains a non-canonical public HTTP(S) URL.",
      error,
    );
  }
}

function decodeFixture(bytes: Uint8Array): DiscoveryFixture {
  if (bytes.byteLength === 0 || bytes.byteLength > 65_536) {
    throw new DiscoveryValidationError(
      "Discovery fixture must contain 1–65536 bytes.",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new DiscoveryValidationError(
      "Discovery fixture must be valid UTF-8 JSON.",
      error,
    );
  }
  const parsed = discoveryFixtureSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DiscoveryValidationError(
      "Discovery fixture does not match schema version 1.",
      parsed.error,
    );
  }
  if (
    new Date(parsed.data.run.completedAt).getTime() <
    new Date(parsed.data.run.startedAt).getTime()
  ) {
    throw new DiscoveryValidationError(
      "Discovery completion time precedes its start time.",
    );
  }

  const identities = new Set<string>();
  for (const result of parsed.data.results) {
    exactUrl(result.observedUrl);
    exactUrl(result.canonicalUrl);
    exactUrl(result.ownershipEvidence.candidacy.officialImport.sourceUrl);
    exactUrl(result.ownershipEvidence.sourceAssociation.observedUrl);
    if (
      result.ownershipEvidence.sourceAssociation.observedUrl !==
      result.observedUrl
    ) {
      throw new DiscoveryValidationError(
        "Discovery ownership evidence URL does not match the observed URL.",
      );
    }
    if (result.observedUrl !== result.canonicalUrl) {
      throw new DiscoveryValidationError(
        "Fixture discovery observed and canonical URLs must match exactly.",
      );
    }
    if (
      result.ownershipEvidence.candidacy.upstreamKey !==
      result.candidacyUpstreamKey
    ) {
      throw new DiscoveryValidationError(
        "Discovery ownership evidence upstream key does not match the result.",
      );
    }
    const identity = `${result.candidacyUpstreamKey}\u001f${result.canonicalUrl}`;
    if (identities.has(identity)) {
      throw new DiscoveryValidationError(
        "Discovery fixture contains a duplicate result identity.",
      );
    }
    identities.add(identity);
  }
  return parsed.data;
}

function validateDecisionInput(now: string, note?: string): string | null {
  if (!z.iso.datetime().safeParse(now).success) {
    throw new DiscoveryTransitionError("Discovery review time is invalid.");
  }
  if (note === undefined) {
    return null;
  }
  const parsed = boundedText(500).safeParse(note);
  if (!parsed.success) {
    throw new DiscoveryTransitionError(
      "Discovery reviewer note must contain 1–500 characters.",
    );
  }
  return parsed.data;
}

export async function recordDiscoveryFixture(
  db: PGlite,
  bytes: Uint8Array,
): Promise<DiscoveryRecordResult> {
  const fixture = decodeFixture(bytes);
  const payloadSha256 = sha256(bytes);

  return runStage(
    db,
    {
      stage: "discovery-record",
      idempotencyKey: stableId(
        "discovery-record-stage",
        fixture.run.municipalitySlug,
        fixture.run.electionDate,
        fixture.run.method,
        fixture.run.methodVersion,
        payloadSha256,
        fixture.run.startedAt,
      ),
      processorName: "manual-discovery-fixture",
      processorVersion: "1",
      inputRefs: {
        municipalitySlug: fixture.run.municipalitySlug,
        electionDate: fixture.run.electionDate,
        payloadSha256,
      },
      now: fixture.run.completedAt,
    },
    async (tx) => {
      const election = await tx.query<{ id: string }>(
        `SELECT e.id
           FROM elections e
           JOIN municipalities m ON m.id = e.municipality_id
          WHERE m.slug = $1 AND e.election_date = $2`,
        [fixture.run.municipalitySlug, fixture.run.electionDate],
      );
      if (election.rows.length !== 1) {
        throw new DiscoveryValidationError(
          "Discovery fixture election does not resolve to one official election.",
        );
      }
      const electionId = election.rows[0].id;
      const discoveryRunId = stableId(
        "discovery-run",
        electionId,
        fixture.run.method,
        fixture.run.methodVersion,
        payloadSha256,
        fixture.run.startedAt,
      );
      const existingRun = await tx.query<{ id: string }>(
        "SELECT id FROM discovery_runs WHERE id = $1",
        [discoveryRunId],
      );
      if (existingRun.rows[0]) {
        const existing = await tx.query<{ id: string }>(
          `SELECT id FROM discovered_sources
            WHERE discovery_run_id = $1 ORDER BY id`,
          [discoveryRunId],
        );
        return {
          discoveryRunId,
          discoveredSourceIds: existing.rows.map((row) => row.id),
        };
      }

      const resolved: Array<{
        candidacyId: string;
        officialImportRunId: string;
        result: DiscoveryFixture["results"][number];
      }> = [];
      for (const result of fixture.results) {
        const linked = await tx.query<{
          candidacy_id: string;
          official_import_run_id: string;
        }>(
          `SELECT h.candidacy_id, h.official_import_run_id
             FROM candidacy_status_history h
             JOIN candidacies c ON c.id = h.candidacy_id
             JOIN official_import_runs ir
               ON ir.id = h.official_import_run_id
            WHERE c.election_id = $1
              AND h.upstream_key = $2
              AND ir.source_url = $3
              AND ir.observed_at = $4`,
          [
            electionId,
            result.candidacyUpstreamKey,
            result.ownershipEvidence.candidacy.officialImport.sourceUrl,
            result.ownershipEvidence.candidacy.officialImport.observedAt,
          ],
        );
        if (linked.rows.length !== 1) {
          throw new DiscoveryValidationError(
            "Discovery ownership evidence does not resolve to one official candidacy observation.",
          );
        }
        resolved.push({
          candidacyId: linked.rows[0].candidacy_id,
          officialImportRunId: linked.rows[0].official_import_run_id,
          result,
        });
      }

      await tx.query(
        `INSERT INTO discovery_runs (
           id, election_id, method, method_version, payload_sha256,
           started_at, completed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          discoveryRunId,
          electionId,
          fixture.run.method,
          fixture.run.methodVersion,
          payloadSha256,
          fixture.run.startedAt,
          fixture.run.completedAt,
        ],
      );

      const discoveredSourceIds: string[] = [];
      for (const item of resolved) {
        const discoveredSourceId = stableId(
          "discovered-source",
          discoveryRunId,
          item.candidacyId,
          item.result.canonicalUrl,
        );
        discoveredSourceIds.push(discoveredSourceId);
        const persistedEvidence = {
          schemaVersion: "1",
          candidacy: {
            kind: "official-candidacy-link",
            officialImportRunId: item.officialImportRunId,
            candidacyId: item.candidacyId,
            upstreamKey: item.result.candidacyUpstreamKey,
          },
          sourceAssociation: item.result.ownershipEvidence.sourceAssociation,
          ...(item.result.ownershipEvidence.note
            ? { note: item.result.ownershipEvidence.note }
            : {}),
        };
        await tx.query(
          `INSERT INTO discovered_sources (
             id, discovery_run_id, candidacy_id, observed_url, canonical_url,
             proposed_title, source_type, ownership_evidence, observed_at,
             status
           ) VALUES (
             $1, $2, $3, $4, $5, $6, 'website', $7::jsonb, $8, 'proposed'
           )`,
          [
            discoveredSourceId,
            discoveryRunId,
            item.candidacyId,
            item.result.observedUrl,
            item.result.canonicalUrl,
            item.result.proposedTitle,
            JSON.stringify(persistedEvidence),
            item.result.observedAt,
          ],
        );
      }

      return { discoveryRunId, discoveredSourceIds };
    },
  );
}

async function loadDecision(
  db: QueryClient,
  discoveredSourceId: string,
): Promise<{
  id: string;
  candidacy_id: string;
  canonical_url: string;
  proposed_title: string;
  status: "proposed" | "accepted" | "rejected";
  accepted_source_id: string | null;
  rejection_reason:
    | "ownership-not-established"
    | "duplicate"
    | "out-of-scope"
    | null;
}> {
  const result = await db.query<{
    id: string;
    candidacy_id: string;
    canonical_url: string;
    proposed_title: string;
    status: "proposed" | "accepted" | "rejected";
    accepted_source_id: string | null;
    rejection_reason:
      | "ownership-not-established"
      | "duplicate"
      | "out-of-scope"
      | null;
  }>(
    `SELECT id, candidacy_id, canonical_url, proposed_title, status,
            accepted_source_id, rejection_reason
       FROM discovered_sources
      WHERE id = $1`,
    [discoveredSourceId],
  );
  if (!result.rows[0]) {
    throw new DiscoveryTransitionError(
      "Discovered source does not exist.",
    );
  }
  return result.rows[0];
}

async function reconcileSource(
  tx: Transaction,
  discovery: Awaited<ReturnType<typeof loadDecision>>,
): Promise<string> {
  const sourceId = stableId(
    "source",
    discovery.candidacy_id,
    discovery.canonical_url,
  );
  const existing = await tx.query<{
    id: string;
    source_type: string;
    title: string;
    attribution_policy: string;
    active: boolean;
  }>(
    `SELECT id, source_type, title, attribution_policy, active
       FROM sources
      WHERE candidacy_id = $1 AND canonical_url = $2`,
    [discovery.candidacy_id, discovery.canonical_url],
  );
  if (existing.rows[0]) {
    const source = existing.rows[0];
    if (
      source.id !== sourceId ||
      source.source_type !== "website" ||
      source.title !== discovery.proposed_title ||
      source.attribution_policy !== "candidate_owned" ||
      source.active !== true
    ) {
      throw new DiscoverySourceConflictError(
        "Existing source metadata conflicts with the accepted discovery.",
      );
    }
    return source.id;
  }
  await tx.query(
    `INSERT INTO sources (
       id, candidacy_id, source_type, title, canonical_url,
       attribution_policy, active
     ) VALUES ($1, $2, 'website', $3, $4, 'candidate_owned', true)`,
    [
      sourceId,
      discovery.candidacy_id,
      discovery.proposed_title,
      discovery.canonical_url,
    ],
  );
  return sourceId;
}

export async function acceptDiscoveredSource(
  db: PGlite,
  discoveredSourceId: string,
  now: string,
  note?: string,
): Promise<DiscoveryDecisionResult> {
  const reviewerNote = validateDecisionInput(now, note);
  return runStage(
    db,
    {
      stage: "discovery-accept",
      idempotencyKey: stableId("discovery-accept", discoveredSourceId),
      processorName: "manual-discovery-review",
      processorVersion: "1",
      inputRefs: { discoveredSourceId },
      now,
    },
    async (tx) => {
      const discovery = await loadDecision(tx, discoveredSourceId);
      if (discovery.status === "accepted" && discovery.accepted_source_id) {
        return {
          discoveredSourceId,
          status: "accepted",
          sourceId: discovery.accepted_source_id,
        };
      }
      if (discovery.status !== "proposed") {
        throw new DiscoveryTransitionError(
          "Rejected discovery cannot be accepted.",
        );
      }
      const sourceId = await reconcileSource(tx, discovery);
      const updated = await tx.query<{ id: string }>(
        `UPDATE discovered_sources
            SET status = 'accepted', reviewed_at = $1, reviewer_note = $2,
                accepted_source_id = $3
          WHERE id = $4 AND status = 'proposed'
          RETURNING id`,
        [now, reviewerNote, sourceId, discoveredSourceId],
      );
      if (!updated.rows[0]) {
        throw new DiscoveryTransitionError(
          "Discovery acceptance lost a concurrent state transition.",
        );
      }
      return { discoveredSourceId, status: "accepted", sourceId };
    },
  );
}

export async function rejectDiscoveredSource(
  db: PGlite,
  discoveredSourceId: string,
  now: string,
  reason: "ownership-not-established" | "duplicate" | "out-of-scope",
  note?: string,
): Promise<DiscoveryDecisionResult> {
  const reviewerNote = validateDecisionInput(now, note);
  const reasonResult = z
    .enum(["ownership-not-established", "duplicate", "out-of-scope"])
    .safeParse(reason);
  if (!reasonResult.success) {
    throw new DiscoveryTransitionError(
      "Discovery rejection reason is invalid.",
    );
  }
  return runStage(
    db,
    {
      stage: "discovery-reject",
      idempotencyKey: stableId("discovery-reject", discoveredSourceId),
      processorName: "manual-discovery-review",
      processorVersion: "1",
      inputRefs: { discoveredSourceId, reason: reasonResult.data },
      now,
      validateReplay: async () => {
        const discovery = await loadDecision(db, discoveredSourceId);
        if (
          discovery.status !== "rejected" ||
          discovery.rejection_reason !== reasonResult.data
        ) {
          throw new DiscoveryTransitionError(
            "Cached discovery rejection conflicts with the requested reason.",
          );
        }
      },
    },
    async (tx) => {
      const discovery = await loadDecision(tx, discoveredSourceId);
      if (discovery.status === "rejected") {
        if (discovery.rejection_reason !== reasonResult.data) {
          throw new DiscoveryTransitionError(
            "Discovery is already rejected for a different reason.",
          );
        }
        return { discoveredSourceId, status: "rejected", sourceId: null };
      }
      if (discovery.status !== "proposed") {
        throw new DiscoveryTransitionError(
          "Accepted discovery cannot be rejected.",
        );
      }
      const updated = await tx.query<{ id: string }>(
        `UPDATE discovered_sources
            SET status = 'rejected', reviewed_at = $1, reviewer_note = $2,
                rejection_reason = $3
          WHERE id = $4 AND status = 'proposed'
          RETURNING id`,
        [now, reviewerNote, reasonResult.data, discoveredSourceId],
      );
      if (!updated.rows[0]) {
        throw new DiscoveryTransitionError(
          "Discovery rejection lost a concurrent state transition.",
        );
      }
      return { discoveredSourceId, status: "rejected", sourceId: null };
    },
  );
}
