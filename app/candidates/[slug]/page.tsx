import { notFound } from "next/navigation";
import { EvidenceCard } from "@/components/evidence-card";
import { getAppDatabase } from "@/lib/db/client";
import { getPublicCandidateRecord } from "@/lib/publication/public";

export const dynamic = "force-dynamic";

const candidacyStatusLabels = {
  registered: "Registered candidacy",
  withdrawn: "Withdrawn candidacy",
  elected: "Elected",
  not_elected: "Not elected",
} as const;

export default async function CandidatePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const candidate = await getPublicCandidateRecord(
    await getAppDatabase(),
    slug,
  );
  if (!candidate) {
    notFound();
  }

  return (
    <main id="main-content" className="candidate-page" tabIndex={-1}>
      <section className="candidate-hero">
        <div className="eyebrow">
          {candidate.municipalityName} · {candidate.electionName}
        </div>
        <div className="candidate-heading">
          <div>
            <h1>{candidate.candidateName}</h1>
            <p>{candidate.officeName}</p>
          </div>
          <span className="status-pill">
            {candidacyStatusLabels[candidate.candidacyStatus]}
          </span>
        </div>
      </section>

      <aside className="coverage-note" aria-labelledby="coverage-title">
        <div className="coverage-icon" aria-hidden="true">
          i
        </div>
        <div>
          <h2 id="coverage-title">Coverage boundary</h2>
          <p>
            {candidate.coverageComplete
              ? `${candidate.reviewedSourceCount} candidate-owned source reviewed through July 24, 2026.`
              : "Source review is incomplete. Absence claims are disabled."}{" "}
            This is a bounded demonstration, not a claim that the entire public
            web was searched.
          </p>
          <ul className="source-list">
            {candidate.sources.map((source) => (
              <li key={source.url}>
                <a href={source.url}>{source.title}</a>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <section className="issue-record" aria-labelledby="record-title">
        <div className="section-heading">
          <div>
            <div className="eyebrow">Issue record</div>
            <h2 id="record-title">Explicit public statements</h2>
          </div>
          <p>
            Topics organize evidence. They do not score, rank, or infer a
            candidate position.
          </p>
        </div>

        <div className="issue-list">
          {candidate.issues.map((issue) => (
            <section
              className="issue-section"
              key={issue.slug}
              aria-labelledby={`issue-${issue.slug}`}
            >
              <div className="issue-title-row">
                <h2 id={`issue-${issue.slug}`}>{issue.label}</h2>
                <span>
                  {issue.statements.length > 0
                    ? "Statement available"
                    : issue.absenceMessage?.startsWith("No explicit")
                      ? "No statement found"
                      : "Review incomplete"}
                </span>
              </div>
              {issue.statements.map((statement) => (
                <EvidenceCard
                  key={statement.statementId}
                  statement={statement}
                />
              ))}
              {issue.absenceMessage ? (
                <div className="empty-state">
                  <span aria-hidden="true">—</span>
                  <div>
                    <strong>
                      {issue.absenceMessage.startsWith("No explicit")
                        ? "No statement in reviewed sources"
                        : "Editorial review is not complete"}
                    </strong>
                    <p>{issue.absenceMessage}</p>
                  </div>
                </div>
              ) : null}
            </section>
          ))}
        </div>
      </section>
    </main>
  );
}
