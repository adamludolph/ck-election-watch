import type { PublishedStatementPayloadV1 } from "@/lib/publication/payload";

export function EvidenceCard({
  statement,
}: {
  statement: PublishedStatementPayloadV1;
}) {
  const evidence = statement.evidence;
  return (
    <article className="statement-card">
      <div className="statement-label">Published statement</div>
      <h3>{statement.summary}</h3>
      <blockquote>“{evidence.quote}”</blockquote>
      <details className="evidence-details">
        <summary>
          Inspect the evidence trace
          <span aria-hidden="true">⌄</span>
        </summary>
        <div className="evidence-body">
          <dl className="evidence-grid">
            <div>
              <dt>Captured source</dt>
              <dd>
                <a href={evidence.originalUrl}>{evidence.sourceTitle}</a>
              </dd>
            </div>
            <div>
              <dt>Capture time</dt>
              <dd>
                <time dateTime={evidence.capturedAt}>
                  {new Intl.DateTimeFormat("en-CA", {
                    dateStyle: "medium",
                    timeStyle: "short",
                    timeZone: "UTC",
                  }).format(new Date(evidence.capturedAt))}{" "}
                  UTC
                </time>
              </dd>
            </div>
            <div>
              <dt>Normalized block</dt>
              <dd className="mono">{evidence.blockId}</dd>
            </div>
            <div>
              <dt>Quote offsets</dt>
              <dd className="mono">
                {evidence.startOffset}–{evidence.endOffset} (UTF-16)
              </dd>
            </div>
          </dl>
          <div className="source-block">
            <span>Captured text block</span>
            <p>{evidence.normalizedBlockText}</p>
          </div>
          <div className="hash-row">
            <span>Snapshot SHA-256</span>
            <code>{evidence.snapshotSha256}</code>
          </div>
        </div>
      </details>
    </article>
  );
}
