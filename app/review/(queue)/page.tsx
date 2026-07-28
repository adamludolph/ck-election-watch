import Link from "next/link";
import { notFound } from "next/navigation";
import { getAppDatabase } from "@/lib/db/client";
import { assertLocalReviewEnabled } from "@/lib/editorial/guard";
import {
  getReviewQueue,
  reviewFilterLabels,
} from "@/lib/editorial/queries";
import {
  editorialPhases,
  type EditorialPhase,
} from "@/lib/editorial/types";

export const dynamic = "force-dynamic";

function validFilter(value: string | undefined): "all" | EditorialPhase {
  if (value === "all" || editorialPhases.includes(value as EditorialPhase)) {
    return value as "all" | EditorialPhase;
  }
  return "needs_review";
}

const phaseLabels = Object.fromEntries(
  reviewFilterLabels
    .filter(({ value }) => value !== "all")
    .map(({ value, label }) => [value, label]),
) as Record<EditorialPhase, string>;

export default async function ReviewQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  try {
    assertLocalReviewEnabled();
  } catch {
    notFound();
  }
  const filter = validFilter((await searchParams).state);
  const queue = await getReviewQueue(await getAppDatabase(), filter);

  return (
    <main id="main-content" className="review-page review-queue-page" tabIndex={-1}>
      <section className="review-intro" aria-labelledby="review-title">
        <div>
          <div className="eyebrow">Local review workspace</div>
          <h1 id="review-title">Editorial review</h1>
        </div>
        <p>
          Inspect the complete synthetic evidence trace before recording a
          decision. This workspace is unavailable in production.
        </p>
      </section>

      <section className="review-headline-counts" aria-label="Current work">
        {[
          "needs_review",
          "ready_to_approve",
          "approved_unpublished",
          "published",
        ].map((phase) => (
          <div key={phase}>
            <strong>{queue.counts[phase as EditorialPhase]}</strong>
            <span>{phaseLabels[phase as EditorialPhase]}</span>
          </div>
        ))}
      </section>

      <div className="review-workspace">
        <nav className="review-filters" aria-label="Editorial states">
          {reviewFilterLabels.map(({ value, label }) => (
            <Link
              key={value}
              href={value === "needs_review" ? "/review" : `/review?state=${value}`}
              aria-current={filter === value ? "page" : undefined}
            >
              <span>{label}</span>
              <strong>{queue.counts[value]}</strong>
            </Link>
          ))}
        </nav>

        <section className="review-records" aria-labelledby="queue-heading">
          <div className="review-list-heading">
            <div>
              <span>Selected state</span>
              <h2 id="queue-heading">
                {filter === "all" ? "All records" : phaseLabels[filter]}
              </h2>
            </div>
            <strong>{queue.records.length} records</strong>
          </div>
          {queue.records.length === 0 ? (
            <div className="review-empty">
              <h3>No records in this state</h3>
              <p>
                The fixture is prepared correctly; there is simply no work in
                this filter.
              </p>
              <Link href="/review?state=all">View all records</Link>
            </div>
          ) : (
            <ol className="review-record-list">
              {queue.records.map((record) => (
                <li key={record.statementId}>
                  <Link
                    href={`/review/statements/${record.statementId}?from=${filter}`}
                  >
                    <div className="review-row-topline">
                      <span className={`review-phase review-phase-${record.phase}`}>
                        {phaseLabels[record.phase]}
                      </span>
                      <span>{record.issueLabel}</span>
                    </div>
                    <h3>{record.summary}</h3>
                    <dl>
                      <div>
                        <dt>Candidate</dt>
                        <dd>{record.candidateName}</dd>
                      </div>
                      <div>
                        <dt>Source</dt>
                        <dd>{record.sourceTitle}</dd>
                      </div>
                      <div>
                        <dt>Captured</dt>
                        <dd>
                          <time dateTime={record.capturedAt}>
                            {new Date(record.capturedAt).toLocaleString("en-CA")}
                          </time>
                        </dd>
                      </div>
                    </dl>
                    <strong className="review-row-action">
                      Inspect evidence <span aria-hidden="true">→</span>
                    </strong>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </main>
  );
}
