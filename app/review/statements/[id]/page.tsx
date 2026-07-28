import Link from "next/link";
import { notFound } from "next/navigation";
import { EditorialRecordNotFoundError } from "@/lib/core/errors";
import { getAppDatabase } from "@/lib/db/client";
import { assertLocalReviewEnabled } from "@/lib/editorial/guard";
import { getReviewStatement } from "@/lib/editorial/queries";
import { ReviewActions } from "@/components/review/review-actions";

export const dynamic = "force-dynamic";

const phaseLabels = {
  needs_review: "Needs review",
  changes_requested: "Changes requested",
  ready_to_approve: "Ready to approve",
  approved_unpublished: "Approved unpublished",
  published: "Published",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
} as const;

const historyLabels: Record<string, string> = {
  reviewed_ready: "Marked ready to approve",
  reviewed_changes_requested: "Requested changes",
  approved: "Approved statement",
  rejected: "Rejected statement",
  published: "Published statement",
  unpublished: "Unpublished statement",
  withdrawn: "Closed statement after unpublication",
};

export default async function ReviewStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  try {
    assertLocalReviewEnabled();
  } catch {
    notFound();
  }
  const { id } = await params;
  let record;
  try {
    record = await getReviewStatement(await getAppDatabase(), id);
  } catch (error) {
    if (error instanceof EditorialRecordNotFoundError) {
      notFound();
    }
    throw error;
  }
  const from = (await searchParams).from ?? "needs_review";
  const queueHref =
    from === "needs_review" ? "/review" : `/review?state=${encodeURIComponent(from)}`;

  return (
    <main id="main-content" className="review-page review-detail-page" tabIndex={-1}>
      <nav className="review-breadcrumb" aria-label="Breadcrumb">
        <Link href={queueHref}>Editorial review</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">Statement evidence</span>
      </nav>

      <header className="review-detail-header">
        <div>
          <div className="eyebrow">Internal editorial record</div>
          <h1>{record.summary}</h1>
        </div>
        <div className="review-orientation">
          <span className={`review-phase review-phase-${record.phase}`}>
            {phaseLabels[record.phase]}
          </span>
          <strong>{record.issueLabel}</strong>
          <span>{record.candidateName}</span>
        </div>
      </header>

      <div className="review-detail-layout">
        <article className="review-trace" aria-label="Evidence trace">
          {record.blockedReason ? (
            <div className="review-message review-message-error">
              <strong>Evidence validation blocked</strong>
              <span>{record.blockedReason}</span>
            </div>
          ) : null}

          <section className="review-trace-section" aria-labelledby="trace-statement">
            <div className="review-trace-number">1</div>
            <div>
              <span className="review-trace-kicker">Statement</span>
              <h2 id="trace-statement">Normalized public claim</h2>
              <p className="review-statement-text">{record.summary}</p>
              <dl className="review-metadata">
                <div>
                  <dt>Extraction item</dt>
                  <dd><code>{record.extractionItemId}</code></dd>
                </div>
                <div>
                  <dt>Review subject SHA-256</dt>
                  <dd><code>{record.reviewSubjectSha256 ?? "Unavailable"}</code></dd>
                </div>
              </dl>
            </div>
          </section>

          <section className="review-trace-section" aria-labelledby="trace-evidence">
            <div className="review-trace-number">2</div>
            <div>
              <span className="review-trace-kicker">Evidence</span>
              <h2 id="trace-evidence">Exact supporting quote</h2>
              <blockquote>{record.evidenceQuote}</blockquote>
              <dl className="review-metadata">
                <div>
                  <dt>Offsets</dt>
                  <dd>{record.startOffset}–{record.endOffset}</dd>
                </div>
                <div>
                  <dt>Controlled issue</dt>
                  <dd>{record.issueLabel}</dd>
                </div>
              </dl>
            </div>
          </section>

          <details className="review-trace-details">
            <summary>
              <span><b>3</b> Extraction</span>
              <strong>Inspect run identity</strong>
            </summary>
            <div className="review-details-body">
              <h2>Structured extraction record</h2>
              <dl className="review-metadata">
                <div>
                  <dt>Run ID</dt>
                  <dd><code>{record.extractionRunId}</code></dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd>{record.model}</dd>
                </div>
                <div>
                  <dt>Schema</dt>
                  <dd>{record.schemaVersion}</dd>
                </div>
              </dl>
            </div>
          </details>

          <details className="review-trace-details">
            <summary>
              <span><b>4</b> Normalized content</span>
              <strong>Inspect source block</strong>
            </summary>
            <div className="review-details-body">
              <h2>Normalized evidence block</h2>
              <p className="review-normalized-text">{record.normalizedText}</p>
              <dl className="review-metadata">
                <div>
                  <dt>Block ID</dt>
                  <dd><code>{record.normalizedBlockId}</code></dd>
                </div>
                <div>
                  <dt>Block SHA-256</dt>
                  <dd><code>{record.normalizedTextSha256}</code></dd>
                </div>
              </dl>
            </div>
          </details>

          <details className="review-trace-details">
            <summary>
              <span><b>5</b> Source snapshot</span>
              <strong>Inspect immutable capture</strong>
            </summary>
            <div className="review-details-body">
              <h2>Captured synthetic page</h2>
              <dl className="review-metadata">
                <div>
                  <dt>Source</dt>
                  <dd><a href={record.originalUrl}>{record.sourceTitle}</a></dd>
                </div>
                <div>
                  <dt>Captured</dt>
                  <dd><time dateTime={record.capturedAt}>{new Date(record.capturedAt).toLocaleString("en-CA")}</time></dd>
                </div>
                <div>
                  <dt>Snapshot ID</dt>
                  <dd><code>{record.snapshotId}</code></dd>
                </div>
                <div>
                  <dt>Snapshot SHA-256</dt>
                  <dd><code>{record.snapshotSha256}</code></dd>
                </div>
                <div>
                  <dt>Bytes</dt>
                  <dd>{record.snapshotByteLength}</dd>
                </div>
              </dl>
              <pre className="review-source-snapshot">{record.rawSnapshot}</pre>
            </div>
          </details>
        </article>

        <ReviewActions
          statementId={record.statementId}
          candidacySlug={record.candidacySlug}
          phase={record.phase}
          blockedReason={record.blockedReason}
        />
      </div>

      <section className="review-history" aria-labelledby="history-title">
        <div className="review-region-heading">
          <span>Append-only audit record</span>
          <h2 id="history-title">Decision history</h2>
        </div>
        {record.history.length === 0 ? (
          <div className="review-empty">
            <h3>No decisions recorded yet</h3>
            <p>The first valid review decision will appear here.</p>
          </div>
        ) : (
          <ol>
            {record.history.map((item) => (
              <li key={`${item.requestId}:${item.eventTypes.join(",")}`}>
                <div className="review-history-marker" aria-hidden="true" />
                <div>
                  <div className="review-history-heading">
                    <strong>
                      {item.eventTypes.map((event) => historyLabels[event] ?? event).join(" · ")}
                    </strong>
                    <time dateTime={item.occurredAt}>
                      {new Date(item.occurredAt).toLocaleString("en-CA")}
                    </time>
                  </div>
                  <span>{item.operatorRef === "migration:milestone-2" ? "Milestone 2 import" : item.operatorRef}</span>
                  {item.note ? <p>{item.note}</p> : null}
                  {item.reason ? <p>{item.reason}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
