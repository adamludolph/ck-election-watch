import { z } from "zod";

const statementItemSchema = z.object({
  kind: z.literal("statement"),
  statementId: z.string().min(1),
  blockId: z.string().min(1),
  quote: z.string().min(1),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(),
  attributedTo: z.enum(["candidate", "campaign"]),
  summary: z.string().min(1),
  issueSlugs: z.array(z.string().min(1)).min(1),
  confidence: z.number().min(0).max(1),
});

const abstainItemSchema = z.object({
  kind: z.literal("abstain"),
  blockId: z.string().min(1),
  reason: z.enum([
    "ambiguous-attribution",
    "non-explicit",
    "third-party",
    "insufficient-evidence",
  ]),
});

export const extractionResultV1Schema = z.object({
  schemaVersion: z.literal("1"),
  items: z.array(z.discriminatedUnion("kind", [
    statementItemSchema,
    abstainItemSchema,
  ])),
});

export type ExtractionResultV1 = z.infer<typeof extractionResultV1Schema>;
