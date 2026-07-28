"use server";

import {
  handleReviewAction,
  type ReviewActionState,
} from "@/lib/editorial/action-handler";
import { getAppDatabase } from "@/lib/db/client";

export async function reviewAction(
  _previousState: ReviewActionState,
  formData: FormData,
): Promise<ReviewActionState> {
  return handleReviewAction(formData, {
    getDatabase: getAppDatabase,
  });
}
