import { describe, expect, it } from "vitest";
import { NormalizationEmptyError } from "@/lib/core/errors";
import { sha256 } from "@/lib/core/hash";
import { normalizeHtml } from "@/lib/ingest/normalize";

describe("normalizeHtml", () => {
  it("creates stable evidence-addressable blocks and removes private chrome", () => {
    const html =
      "<body><nav>skip</nav><main><h1> Plan </h1><p>Hello   world</p><p hidden>secret</p></main></body>";
    const digest = sha256(html);
    const first = normalizeHtml(html, digest);
    const second = normalizeHtml(html, digest);
    expect(first).toEqual(second);
    expect(first.map((block) => block.text)).toEqual(["Plan", "Hello world"]);
    expect(first[1].id).toMatch(
      new RegExp(`^block_${digest.slice(0, 12)}_1_`),
    );
  });

  it("rejects a document without eligible content", () => {
    expect(() =>
      normalizeHtml("<body><script>only()</script></body>", sha256("empty")),
    ).toThrow(NormalizationEmptyError);
  });

  it("falls back to body and ignores empty nodes", () => {
    const blocks = normalizeHtml(
      "<body><p> </p><p>Body content</p></body>",
      sha256("body"),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("Body content");
  });
});
