import { load } from "cheerio";
import type { PGlite } from "@electric-sql/pglite";
import { NormalizationEmptyError } from "@/lib/core/errors";
import { sha256 } from "@/lib/core/hash";
import { runStage } from "@/lib/pipeline/stage";

export type NormalizedBlock = {
  id: string;
  ordinal: number;
  blockType: string;
  text: string;
  textSha256: string;
};

export function normalizeHtml(
  html: string,
  snapshotSha256: string,
): NormalizedBlock[] {
  const $ = load(html);
  $("script, style, nav, footer, [hidden], [aria-hidden='true']").remove();
  const root = $("main").first().length ? $("main").first() : $("body").first();
  const blocks: NormalizedBlock[] = [];
  root.find("h1, h2, h3, h4, h5, h6, p, li").each((_, element) => {
    const text = $(element).text().replace(/\s+/gu, " ").trim();
    if (!text) {
      return;
    }
    const textSha256 = sha256(text);
    const ordinal = blocks.length;
    blocks.push({
      id: `block_${snapshotSha256.slice(0, 12)}_${ordinal}_${textSha256.slice(0, 12)}`,
      ordinal,
      blockType: element.tagName.toLowerCase(),
      text,
      textSha256,
    });
  });
  if (blocks.length === 0) {
    throw new NormalizationEmptyError();
  }
  return blocks;
}

export async function normalizeSnapshot(
  db: PGlite,
  snapshotId: string,
  now: string,
): Promise<{ snapshotId: string; blockIds: string[] }> {
  const snapshot = await db.query<{
    raw_content: Uint8Array;
    content_sha256: string;
  }>(
    `SELECT raw_content, content_sha256
       FROM source_snapshots
      WHERE id = $1`,
    [snapshotId],
  );
  const row = snapshot.rows[0];
  if (!row) {
    throw new NormalizationEmptyError("Snapshot does not exist.");
  }
  const blocks = normalizeHtml(
    new TextDecoder("utf-8", { fatal: true }).decode(row.raw_content),
    row.content_sha256,
  );
  return runStage(
    db,
    {
      stage: "normalize",
      idempotencyKey: `${snapshotId}:${row.content_sha256}`,
      processorName: "html-block-normalizer",
      processorVersion: "1",
      inputRefs: { snapshotId, contentSha256: row.content_sha256 },
      now,
    },
    async () => {
      for (const block of blocks) {
        await db.query(
          `INSERT INTO normalized_blocks (
             id, snapshot_id, ordinal, block_type, text, text_sha256
           ) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (snapshot_id, ordinal) DO NOTHING`,
          [
            block.id,
            snapshotId,
            block.ordinal,
            block.blockType,
            block.text,
            block.textSha256,
          ],
        );
      }
      return { snapshotId, blockIds: blocks.map((block) => block.id) };
    },
  );
}
