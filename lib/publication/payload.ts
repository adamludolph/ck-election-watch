import { canonicalize } from "json-canonicalize";
import { z } from "zod";
import { PublicationPolicyError } from "@/lib/core/errors";
import { sha256 } from "@/lib/core/hash";

export const publishedStatementPayloadV1Schema = z.object({
  version: z.literal("1"),
  statementId: z.string(),
  candidacySlug: z.string(),
  summary: z.string(),
  issues: z.array(
    z.object({
      slug: z.string(),
      label: z.string(),
    }),
  ),
  evidence: z.object({
    quote: z.string(),
    blockId: z.string(),
    normalizedBlockText: z.string(),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().positive(),
    sourceTitle: z.string(),
    originalUrl: z.url(),
    capturedAt: z.iso.datetime(),
    snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});

export type PublishedStatementPayloadV1 = z.infer<
  typeof publishedStatementPayloadV1Schema
>;

export function digestPublicationPayload(
  payload: PublishedStatementPayloadV1,
): string {
  return sha256(canonicalize(payload));
}

export function verifyPublicationPayload(
  rawPayload: unknown,
  expectedSha256: string,
): PublishedStatementPayloadV1 {
  const parsed = publishedStatementPayloadV1Schema.safeParse(rawPayload);
  if (!parsed.success) {
    throw new PublicationPolicyError("Published payload schema is invalid.");
  }
  if (digestPublicationPayload(parsed.data) !== expectedSha256) {
    throw new PublicationPolicyError("Published payload digest does not match.");
  }
  return parsed.data;
}
