export const editorialPhases = [
  "needs_review",
  "changes_requested",
  "ready_to_approve",
  "approved_unpublished",
  "published",
  "rejected",
  "withdrawn",
] as const;

export type EditorialPhase = (typeof editorialPhases)[number];

export const editorialActions = [
  "reviewed_ready",
  "reviewed_changes_requested",
  "approved",
  "rejected",
  "published",
  "unpublished",
] as const;

export type EditorialAction = (typeof editorialActions)[number];

export type EditorialActionResult = {
  statementId: string;
  action: EditorialAction;
  phase: EditorialPhase;
  eventIds: string[];
  publicationId?: string;
};
