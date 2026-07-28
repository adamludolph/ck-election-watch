import { describe, expect, it } from "vitest";
import { LocalReviewDisabledError } from "@/lib/core/errors";
import {
  assertLocalReviewEnabled,
  isLocalReviewEnabled,
} from "@/lib/editorial/guard";

describe("local review guard", () => {
  it("enables development and test but fails closed in production", () => {
    expect(isLocalReviewEnabled("development")).toBe(true);
    expect(isLocalReviewEnabled("test")).toBe(true);
    expect(isLocalReviewEnabled("production")).toBe(false);
    expect(() => assertLocalReviewEnabled("production")).toThrow(
      LocalReviewDisabledError,
    );
  });
});
