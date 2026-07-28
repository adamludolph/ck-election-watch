import type { PGlite } from "@electric-sql/pglite";
import { loadEditorialSubject } from "@/lib/editorial/subject";
import { persistPublication } from "@/lib/publication/publish";

export async function seedMilestone2Publication(
  db: PGlite,
  statementId: string,
  now = "2026-07-24T16:10:00.000Z",
): Promise<{ publicationId: string }> {
  return db.transaction(async (tx) => {
    const subject = await loadEditorialSubject(tx, statementId);
    await tx.query(
      "UPDATE statements SET status = 'approved', approved_at = $1 WHERE id = $2",
      [now, statementId],
    );
    const publication = await persistPublication(tx, {
      statementId,
      payload: subject.payload,
      now,
    });
    return { publicationId: publication.publicationId };
  });
}
