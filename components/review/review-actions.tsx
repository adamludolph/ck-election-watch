import { randomUUID } from "node:crypto";
import Link from "next/link";
import { stableId } from "@/lib/core/hash";
import type { EditorialPhase } from "@/lib/editorial/types";
import { ReviewActionForm } from "@/components/review/review-action-form";
import { ReviewActionStatus } from "@/components/review/review-action-status";

export function ReviewActions({
  statementId,
  candidacySlug,
  phase,
  blockedReason,
}: {
  statementId: string;
  candidacySlug: string;
  phase: EditorialPhase;
  blockedReason: string | null;
}) {
  if (blockedReason) {
    return (
      <aside className="review-blocked" aria-labelledby="blocked-title">
        <h2 id="blocked-title">Decision controls blocked</h2>
        <p>{blockedReason}</p>
        <p>Reset the local fixture before recording a decision.</p>
      </aside>
    );
  }
  const formInstanceId = randomUUID();
  const requestId = (action: string) =>
    stableId("review-request", statementId, phase, action, formInstanceId);
  const common = { statementId, candidacySlug, expectedPhase: phase };

  return (
    <aside className="review-controls" aria-labelledby="decision-title">
      <div className="review-region-heading">
        <span>Internal editorial record</span>
        <h2 id="decision-title">Valid next decision</h2>
      </div>
      <ReviewActionStatus />
      {phase === "needs_review" ? (
        <>
          <ReviewActionForm
            {...common}
            action="reviewed_ready"
            requestId={requestId("reviewed_ready")}
            label="Mark ready to approve"
            description="Record that the complete evidence trace is ready for an approval decision."
            field="note"
            fieldLabel="Private review note"
          />
          <ReviewActionForm
            {...common}
            action="reviewed_changes_requested"
            requestId={requestId("reviewed_changes_requested")}
            label="Request changes"
            description="Record why this extracted statement should not proceed to approval."
            field="reason"
            fieldLabel="Private change reason"
            required
          />
        </>
      ) : null}
      {phase === "changes_requested" ? (
        <ReviewActionForm
          {...common}
          action="rejected"
          requestId={requestId("rejected")}
          label="Reject statement"
          description="End this statement's lifecycle. Rejection is terminal."
          field="reason"
          fieldLabel="Private rejection reason"
          required
          destructive
        />
      ) : null}
      {phase === "ready_to_approve" ? (
        <ReviewActionForm
          {...common}
          action="approved"
          requestId={requestId("approved")}
          label="Approve statement"
          description="Freeze the reviewed subject for a later, separate publication decision."
          field="reason"
          fieldLabel="Private approval reason"
          required
        />
      ) : null}
      {phase === "approved_unpublished" ? (
        <ReviewActionForm
          {...common}
          action="published"
          requestId={requestId("published")}
          label="Publish statement"
          description="Make the frozen approved snapshot visible on the local public candidate page."
          field="reason"
          fieldLabel="Private publication note"
          confirmPublicChange
        />
      ) : null}
      {phase === "published" ? (
        <ReviewActionForm
          {...common}
          action="unpublished"
          requestId={requestId("unpublished")}
          label="Unpublish statement"
          description="Remove public visibility while retaining the immutable evidence and decision history."
          field="reason"
          fieldLabel="Private unpublication reason"
          required
          confirmPublicChange
          destructive
        />
      ) : null}
      {phase === "rejected" || phase === "withdrawn" ? (
        <div className="review-terminal">
          <strong>Terminal state</strong>
          <p>
            This statement has no further actions. Its evidence and history
            remain available for audit.
          </p>
        </div>
      ) : null}
      {phase === "published" || phase === "withdrawn" ? (
        <Link
          className="review-public-check"
          href={`/candidates/${candidacySlug}`}
        >
          Verify the public candidate page
        </Link>
      ) : null}
    </aside>
  );
}
