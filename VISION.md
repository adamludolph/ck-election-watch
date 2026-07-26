# Municipal Election Explorer

## Purpose

Municipal Election Explorer is a neutral, evidence-first public record of what
municipal election candidates have said publicly.

The first supported election is the 2026 Chatham-Kent municipal election. The
system must be capable of supporting additional municipalities and elections
through configuration and data, without rewriting the core application.

The product exists to help a voter answer:

> What has this candidate actually said publicly?

It does not tell a voter what to think, how to vote, or which candidate is
better.

## Core commitments

### Evidence first

Every published statement must link to at least one original public source and
to the exact captured evidence used to create it. A statement without adequate
evidence remains a draft and is not published.

The system preserves the source URL, capture time, raw captured material,
normalized content, extraction metadata, and supporting evidence. This makes
the result inspectable even if the original source is later edited or removed.

### Statement Attribution Policy

> A statement attributed to a candidate must be supported by the candidate's
> own public words or an official campaign communication. Journalists'
> interpretations, editorials, social media comments by third parties, and AI
> inferences must never be presented as the candidate's position. Where
> ambiguity exists, the system will abstain rather than infer.

Candidate-owned public words include clearly attributable direct quotations in
a third-party source. A journalist's paraphrase, characterization, headline,
or conclusion is not a candidate statement.

Campaign communications may be attributed to the campaign when authorship is
clear. They must not silently be converted into first-person candidate quotes.

### Never infer

The platform must not:

- infer beliefs, intentions, ideology, motives, or unstated positions;
- convert silence or missing coverage into a position;
- rank, rate, score, endorse, or recommend candidates;
- treat confidence scores as evidence;
- present third-party commentary as a candidate's own statement; or
- make an AI-generated statement public without traceable evidence.

When the reviewed material contains no qualifying evidence, the product says:

> No explicit public statement found in the sources reviewed.

This wording describes the current evidence set. It does not claim that the
candidate has never spoken about the subject.

### Neutrality by design

Neutrality requires more than neutral wording. The same source-acceptance,
capture, extraction, review, and publication rules must apply to every
candidate.

The platform must make coverage limits visible. It must not imply that two
candidates have been researched equally when their available source coverage
differs. Differences in source volume or recency must not become candidate
rankings.

Issues are drawn from a controlled, documented taxonomy. AI may associate a
statement with an allowed issue when the evidence supports it, or leave it
unclassified. AI must not invent political categories.

### Preserve the record responsibly

Captured source material is evidence, not republished inventory. Raw captures
are private operational records unless publication rights have been
established. Public pages show only the minimum excerpt needed to support the
statement and link to the original source.

Collection must respect applicable law, platform terms, privacy obligations,
robots directives where applicable, reasonable request rates, correction
requests, and takedown decisions. Social-platform ingestion requires a
source-specific approval before implementation.

### Human accountability

AI produces drafts. A statement has a minimal publication state:

- `draft`: not eligible for public display;
- `approved`: eligible for public display.

The first vertical slice needs these states, not a review application. A review
interface or richer review history may be added only when the editorial
workflow requires it.

Prompt files, output schemas, models, and prompt versions are part of the
evidence record. Material prompt changes are reviewed like application changes.

### Accessibility and clarity

Public pages should target WCAG 2.2 AA. Evidence links, source dates, candidate
attribution, loading states, empty states, and coverage limitations must be
understandable without specialist knowledge.

## Phase 1

Phase 1 demonstrates one complete, trustworthy path through the evidence
pipeline:

1. Configure the 2026 Chatham-Kent election.
2. Import candidates from the official municipal source.
3. Register a candidate-owned public website.
4. Capture and normalize content from that website.
5. Extract explicit statements and controlled issues using AI.
6. Retain supporting evidence and extraction provenance.
7. Mark selected draft statements as approved.
8. Publish selected approved statements.
9. Display published statements on a candidate profile with original-source
   links.

The initial implementation may also support manual source registration and
manual content entry when that helps validate the same pipeline without
introducing another crawler.

## Explicit non-goals

Phase 1 does not include:

- candidate recommendations or voter matching;
- ideological classifications or political analysis;
- candidate rankings, ratings, or scores;
- comments, voting, endorsements, or social features;
- public user accounts or a full editorial review interface;
- notifications or native mobile applications;
- automatic discovery across the entire web;
- production Facebook, Instagram, YouTube, or news ingestion;
- generalized comparison pages;
- semantic search or automatically generated candidate summaries; or
- publication of full third-party articles or private raw captures.

These are not implied future commitments. Each requires a separate product,
evidence, legal, and technical decision.

## Definition of success

The first vertical slice succeeds when a reviewer can trace a published
statement backwards through:

`Statement -> Evidence -> Extraction -> Normalized content -> Source snapshot -> Original source`

and can reproduce or explain each transformation without relying on hidden
state.

The MVP succeeds when the same workflow works for the official Chatham-Kent
candidate list and at least one supported candidate-content source type, while
the application builds, passes its checks, and preserves the attribution policy
above.
