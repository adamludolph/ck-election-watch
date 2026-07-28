"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { reviewAction } from "@/app/review/actions";
import { initialReviewActionState } from "@/lib/editorial/action-handler";
import { REVIEW_ACTION_SUCCESS_EVENT } from "@/components/review/review-action-status";
import type {
  EditorialAction,
  EditorialPhase,
} from "@/lib/editorial/types";

type ReviewActionFormProps = {
  action: EditorialAction;
  statementId: string;
  candidacySlug: string;
  expectedPhase: EditorialPhase;
  requestId: string;
  label: string;
  description: string;
  field?: "note" | "reason";
  fieldLabel?: string;
  required?: boolean;
  confirmPublicChange?: boolean;
  destructive?: boolean;
};

export function ReviewActionForm({
  action,
  statementId,
  candidacySlug,
  expectedPhase,
  requestId,
  label,
  description,
  field,
  fieldLabel,
  required = false,
  confirmPublicChange = false,
  destructive = false,
}: ReviewActionFormProps) {
  const [state, formAction, pending] = useActionState(
    reviewAction,
    initialReviewActionState,
  );
  const [confirming, setConfirming] = useState(false);
  const revealRef = useRef<HTMLButtonElement>(null);
  const confirmationHeadingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (confirming) {
      confirmationHeadingRef.current?.focus();
    }
  }, [confirming]);

  useEffect(() => {
    if (state.status === "success") {
      window.dispatchEvent(
        new CustomEvent(REVIEW_ACTION_SUCCESS_EVENT, {
          detail: state.message,
        }),
      );
    } else if (state.status === "error") {
      errorRef.current?.focus();
    }
  }, [state]);

  function cancelConfirmation() {
    setConfirming(false);
    requestAnimationFrame(() => revealRef.current?.focus());
  }

  const fieldErrorId =
    state.status === "error" && state.field === field
      ? `${requestId}-error`
      : undefined;

  const formFields = (
    <>
      <input type="hidden" name="action" value={action} />
      <input type="hidden" name="statementId" value={statementId} />
      <input type="hidden" name="candidacySlug" value={candidacySlug} />
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="expectedPhase" value={expectedPhase} />
      {field ? (
        <label className="review-field">
          <span>
            {fieldLabel}
            {required ? " (required)" : " (optional)"}
          </span>
          <textarea
            name={field}
            required={required}
            maxLength={500}
            rows={3}
            aria-describedby={[
              `${requestId}-hint`,
              fieldErrorId,
            ].filter(Boolean).join(" ")}
            aria-invalid={fieldErrorId ? true : undefined}
          />
          <small id={`${requestId}-hint`}>1–500 characters.</small>
          {fieldErrorId ? (
            <span className="review-field-error" id={fieldErrorId}>
              {state.message}
            </span>
          ) : null}
        </label>
      ) : null}
    </>
  );

  return (
    <section
      className={`review-action ${destructive ? "review-action-danger" : ""}`}
      aria-labelledby={`${requestId}-title`}
    >
      <h3 id={`${requestId}-title`}>{label}</h3>
      <p>{description}</p>
      {state.status === "error" ? (
        <div
          className="review-message review-message-error"
          ref={errorRef}
          tabIndex={-1}
          role="alert"
        >
          <strong>Action not recorded</strong>
          <span>{state.message}</span>
          <a href="">Reload current state</a>
        </div>
      ) : null}
      {confirmPublicChange ? (
        state.status === "success" ? null : confirming ? (
          <form
            action={formAction}
            className="review-confirmation"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !pending) {
                event.preventDefault();
                cancelConfirmation();
              }
            }}
          >
            {formFields}
            <fieldset disabled={pending}>
              <legend className="sr-only">Confirm public change</legend>
              <h4 ref={confirmationHeadingRef} tabIndex={-1}>
                Confirm public change
              </h4>
              <p>
                {action === "published"
                  ? "This statement will become visible on the local public candidate page."
                  : "This statement will stop appearing publicly. Its evidence and history remain."}
              </p>
              <div className="review-button-row">
                <button
                  className={destructive ? "danger-button" : "primary-button"}
                  type="submit"
                >
                  {pending ? "Saving…" : `Confirm ${label.toLowerCase()}`}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={cancelConfirmation}
                >
                  Cancel
                </button>
              </div>
            </fieldset>
          </form>
        ) : (
          <div className="review-form-fields">
            {field ? (
              <p className="review-field-prompt">
                {fieldLabel} will be requested before confirmation.
              </p>
            ) : null}
            <button
              className={destructive ? "danger-button" : "primary-button"}
              type="button"
              ref={revealRef}
              onClick={() => setConfirming(true)}
            >
              {label}
            </button>
          </div>
        )
      ) : (
        <form action={formAction}>
          <fieldset disabled={pending}>
            <legend className="sr-only">{label}</legend>
            {formFields}
            <button
              className={destructive ? "danger-button" : "primary-button"}
              type="submit"
            >
              {pending ? "Saving…" : label}
            </button>
          </fieldset>
        </form>
      )}
    </section>
  );
}
