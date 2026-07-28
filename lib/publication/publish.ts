import type { PGlite } from "@electric-sql/pglite";
import { stableId } from "@/lib/core/hash";
import {
  digestPublicationPayload,
  type PublishedStatementPayloadV1,
} from "@/lib/publication/payload";

type QueryClient = Pick<PGlite, "query">;

export async function persistPublication(
  db: QueryClient,
  input: {
    statementId: string;
    payload: PublishedStatementPayloadV1;
    now: string;
  },
): Promise<{ publicationId: string; payloadSha256: string }> {
  const publicationId = stableId("publication", input.statementId);
  const payloadSha256 = digestPublicationPayload(input.payload);
  await db.query(
    `INSERT INTO publications (
       id, statement_id, payload, payload_sha256, published_at
     ) VALUES ($1, $2, $3::jsonb, $4, $5)`,
    [
      publicationId,
      input.statementId,
      JSON.stringify(input.payload),
      payloadSha256,
      input.now,
    ],
  );
  return { publicationId, payloadSha256 };
}
