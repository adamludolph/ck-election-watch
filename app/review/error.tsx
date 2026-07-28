"use client";

export default function ReviewError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main id="main-content" className="review-page review-error" tabIndex={-1}>
      <div className="eyebrow">Local review workspace</div>
      <h1>Review workspace unavailable</h1>
      <p>The fixture-backed editorial records could not be loaded.</p>
      <button className="primary-button" type="button" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
