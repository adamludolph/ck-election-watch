"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export const REVIEW_ACTION_SUCCESS_EVENT = "review-action-success";

export function ReviewActionStatus() {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const statusRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function recordSuccess(event: Event) {
      const detail = (event as CustomEvent<unknown>).detail;
      if (typeof detail === "string") {
        setMessage(detail);
      }
    }
    window.addEventListener(REVIEW_ACTION_SUCCESS_EVENT, recordSuccess);
    return () => {
      window.removeEventListener(REVIEW_ACTION_SUCCESS_EVENT, recordSuccess);
    };
  }, []);

  useEffect(() => {
    if (message) {
      statusRef.current?.focus();
      router.refresh();
    }
  }, [message, router]);

  return message ? (
    <div
      className="review-message review-message-success"
      ref={statusRef}
      tabIndex={-1}
      role="status"
    >
      <strong>Decision recorded</strong>
      <span>{message}</span>
    </div>
  ) : null;
}
