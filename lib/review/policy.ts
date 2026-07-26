import { z } from "zod";

export const attributionInputSchema = z.object({
  sourceRelationship: z.enum([
    "candidate_owned",
    "official_campaign",
    "third_party",
  ]),
  speaker: z.enum([
    "candidate",
    "campaign",
    "journalist",
    "third_party",
    "ambiguous",
  ]),
  explicit: z.boolean(),
});

export type AttributionInput = z.infer<typeof attributionInputSchema>;

export type AttributionDecision =
  | { eligible: true; attributionType: "candidate" | "campaign" }
  | {
      eligible: false;
      reason: "ambiguous-attribution" | "non-explicit" | "third-party";
    };

export function evaluateAttribution(
  rawInput: AttributionInput,
): AttributionDecision {
  const input = attributionInputSchema.parse(rawInput);
  if (!input.explicit) {
    return { eligible: false, reason: "non-explicit" };
  }
  if (input.speaker === "ambiguous") {
    return { eligible: false, reason: "ambiguous-attribution" };
  }
  if (input.speaker === "candidate") {
    return { eligible: true, attributionType: "candidate" };
  }
  if (
    input.speaker === "campaign" &&
    input.sourceRelationship === "official_campaign"
  ) {
    return { eligible: true, attributionType: "campaign" };
  }
  return { eligible: false, reason: "third-party" };
}
