import type { PGlite } from "@electric-sql/pglite";
import { ZodError } from "zod";
import {
  EditorialInputError,
  EditorialRecordNotFoundError,
  EditorialReplayConflictError,
  EditorialSubjectChangedError,
  EditorialTransitionConflictError,
  LocalReviewDisabledError,
  PublicationPolicyError,
} from "@/lib/core/errors";
import { assertLocalReviewEnabled } from "@/lib/editorial/guard";
import type { EditorialPhase } from "@/lib/editorial/types";
import { performEditorialAction } from "@/lib/editorial/workflow";

const LOCAL_OPERATOR_REF = "fixture:local-operator";

export type ReviewActionState = {
  status: "idle" | "success" | "error";
  message: string;
  phase?: EditorialPhase;
  candidacySlug?: string;
  field?: "note" | "reason";
};

export const initialReviewActionState: ReviewActionState = {
  status: "idle",
  message: "",
};

type ActionDependencies = {
  nodeEnv?: string;
  getDatabase: () => Promise<PGlite>;
  clock?: () => string;
};

function formString(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" ? value : undefined;
}

function editorialInputField(
  error: EditorialInputError,
): "note" | "reason" | undefined {
  if (!(error.cause instanceof ZodError)) {
    return undefined;
  }
  const field = error.cause.issues[0]?.path[0];
  return field === "note" || field === "reason" ? field : undefined;
}

export async function handleReviewAction(
  formData: FormData,
  dependencies: ActionDependencies,
): Promise<ReviewActionState> {
  try {
    assertLocalReviewEnabled(dependencies.nodeEnv);
    const db = await dependencies.getDatabase();
    const result = await performEditorialAction(
      db,
      {
        action: formString(formData, "action") as never,
        statementId: formString(formData, "statementId") ?? "",
        requestId: formString(formData, "requestId") ?? "",
        operatorRef: LOCAL_OPERATOR_REF,
        expectedPhase: formString(formData, "expectedPhase") as never,
        note: formString(formData, "note"),
        reason: formString(formData, "reason"),
      },
      dependencies.clock,
    );
    return {
      status: "success",
      message: `Recorded ${result.action.replaceAll("_", " ")}. Current state: ${result.phase.replaceAll("_", " ")}.`,
      phase: result.phase,
      candidacySlug: formString(formData, "candidacySlug"),
    };
  } catch (error) {
    if (error instanceof LocalReviewDisabledError) {
      throw error;
    }
    if (error instanceof EditorialInputError) {
      return {
        status: "error",
        message: error.message,
        field: editorialInputField(error),
      };
    }
    if (
      error instanceof EditorialTransitionConflictError ||
      error instanceof EditorialReplayConflictError ||
      error instanceof EditorialSubjectChangedError ||
      error instanceof EditorialRecordNotFoundError ||
      error instanceof PublicationPolicyError
    ) {
      return {
        status: "error",
        message: error.message,
      };
    }
    throw error;
  }
}
