import { describe, expect, it } from "vitest";
import { PublicationPolicyError } from "@/lib/core/errors";
import {
  digestPublicationPayload,
  verifyPublicationPayload,
  type PublishedStatementPayloadV1,
} from "@/lib/publication/payload";

const payload: PublishedStatementPayloadV1 = {
  version: "1",
  statementId: "statement_1",
  candidacySlug: "demo",
  summary: "A summary",
  issues: [{ slug: "healthcare", label: "Healthcare" }],
  evidence: {
    quote: "Exact words.",
    blockId: "block_1",
    normalizedBlockText: "Exact words.",
    startOffset: 0,
    endOffset: 12,
    sourceTitle: "Campaign platform",
    originalUrl: "https://example.invalid/platform",
    capturedAt: "2026-07-24T16:05:00.000Z",
    snapshotSha256: "a".repeat(64),
  },
};

describe("immutable publication payload", () => {
  it("verifies regardless of object key insertion order", () => {
    const digest = digestPublicationPayload(payload);
    const reordered = JSON.parse(JSON.stringify(payload)) as unknown;
    expect(verifyPublicationPayload(reordered, digest)).toEqual(payload);
  });

  it("fails closed when the payload is tampered", () => {
    const digest = digestPublicationPayload(payload);
    expect(() =>
      verifyPublicationPayload({ ...payload, summary: "Changed" }, digest),
    ).toThrow(PublicationPolicyError);
  });

  it("fails closed when the payload schema is invalid", () => {
    expect(() => verifyPublicationPayload({ version: "2" }, "bad")).toThrow(
      PublicationPolicyError,
    );
  });
});
