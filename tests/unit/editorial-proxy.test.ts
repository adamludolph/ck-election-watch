import { describe, expect, it } from "vitest";
import { productionReviewResponse } from "@/proxy";

describe("review route request boundary", () => {
  it("returns a real 404 in production before route execution", () => {
    expect(productionReviewResponse("production")?.status).toBe(404);
  });

  it("allows development and test requests to continue", () => {
    expect(productionReviewResponse("development")).toBeUndefined();
    expect(productionReviewResponse("test")).toBeUndefined();
  });
});
