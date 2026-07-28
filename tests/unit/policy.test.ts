import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateAttribution } from "@/lib/review/policy";
import { publicAbsenceMessage } from "@/lib/publication/absence";

type PolicyCase = {
  name: string;
  input: Parameters<typeof evaluateAttribution>[0];
  eligible: boolean;
};

const cases = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "tests/fixtures/attribution-policy.v1.json"),
    "utf8",
  ),
) as PolicyCase[];

describe("statement attribution policy", () => {
  it.each(cases)("$name", ({ input, eligible }) => {
    expect(evaluateAttribution(input).eligible).toBe(eligible);
  });

  it("is invariant to candidate name, case order, and irrelevant volume", () => {
    const baseline = cases.map(({ input }) => evaluateAttribution(input));
    const counterfactual = [...cases]
      .reverse()
      .map(({ input }) => evaluateAttribution({ ...input }))
      .reverse();
    expect(counterfactual).toEqual(baseline);
  });
});

describe("public absence wording", () => {
  it("renders nothing when a publication exists", () => {
    expect(
      publicAbsenceMessage({
        coverageComplete: true,
        hasActivePublication: true,
      }),
    ).toBeNull();
  });

  it("uses explicit absence for completed coverage independent of drafts", () => {
    expect(
      publicAbsenceMessage({
        coverageComplete: true,
        hasActivePublication: false,
      }),
    ).toBe(
      "No explicit public statement found in the sources reviewed.",
    );
  });

  it("uses review-aware wording while coverage is incomplete", () => {
    expect(
      publicAbsenceMessage({
        coverageComplete: false,
        hasActivePublication: false,
      }),
    ).toBe("No reviewed statement is currently available.");
  });
});
