# Milestone 3 Editorial Review Test Plan

## Purpose

Prove the complete local, fixture-backed editorial lifecycle without enabling a
production review surface or exposing draft/editorial data through public
queries.

## Test Environment

- Node and package versions remain those already pinned by the repository.
- PGlite runs in memory for unit/integration tests and in `.data/` for the local
  browser fixture.
- `npm run db:prepare` is the only browser-test fixture preparation command. It
  validates and removes only `.data/election-explorer`, then rebuilds it.
- The review workspace is enabled only for the local test/development mode.
- Seeded people, statements, notes, action request IDs, and timestamps are
  deterministic synthetic fixtures. Browser form instances receive distinct
  server-generated request IDs so separate stale tabs cannot replay one
  another's successful action.

## Unit and Integration Coverage

### Migration and invariants

- Apply `0000` through `0004` to an empty database.
- Prepare the exact Milestone 2 schema through `0003`, insert an open approved
  publication, apply `0004`, and verify deterministic legacy approval and
  publication events plus active public visibility.
- Repeat with an already-closed Milestone 2 publication and verify statement
  status `withdrawn`, deterministic approval/withdrawal/publication events, and
  no active public view row.
- Accept a closed legacy publication with a null/blank reason and verify the
  fixed migration reason.
- Fail atomically for approved-without-publication, publication on a non-approved
  statement, missing `approved_at`, withdrawal before publication, reason on an
  open publication, and an over-limit withdrawal reason.
- Re-run the migration application and prove no duplicate history.
- Reject applied-migration digest drift.
- Reject update or delete against both append-only event tables.
- Verify event type, state pair, sequence, digest, request ID, note/reason, and
  actor constraints.

### Editorial service

- Derive every queue phase from projections and latest event sequence.
- Exercise both review outcomes from `needs_review`.
- Approve only the latest `reviewed_ready` subject.
- Reject only the latest `reviewed_changes_requested` subject.
- Publish only an approved, never-published statement whose current subject
  digest matches the latest approved event.
- Unpublish only an active publication and require a reason.
- Treat rejected and withdrawn decisions as terminal.
- Return the original result for an exact request replay.
- Reject a reused request ID with different canonical inputs, including a
  changed private note/reason, while proving stage history stores only a digest.
- Reject a stale expected phase without changing projections or event counts.
- Serialize concurrent duplicate requests to one projection change and one
  success event.
- Allocate monotonically increasing per-statement sequences under a statement
  row lock.
- Reject a service-clock timestamp earlier than the previous event.
- Roll back projection, publication, editorial event, and publication event
  together on every forced failure.

### Evidence and publication policy

- Bind review and approval to the canonical statement/evidence subject digest.
- Mutate summary, attribution, issue ID/slug/label, candidacy ID/slug, evidence
  quote/offset, normalized block ID/text/digest, snapshot ID/digest, source
  title/original URL/capture time, extraction identity, and attribution
  relationship between review and approval; each must block approval.
- Mutate evidence between approval and publication; publication must fail
  without a publication or event.
- Re-run all existing attribution, snapshot, normalized-block, and quote-offset
  checks at publish time.
- Verify the frozen publication payload remains unchanged after internal table
  mutation.

### Public privacy

- Query only `active_publication_payloads` for publication data.
- Return only digest-verified active publication payloads for the requested
  candidacy whose published event references an immutable approval event.
- Remove all draft/editorial-table reads from the public query.
- Prove public query objects and rendered HTML contain none of the private note,
  reason, actor, request ID, event ID, or internal-state sentinel values.
- Prove unpublished and rejected content is absent.
- Prove adding/changing private drafts and events cannot change the public
  response, including absence wording.
- Prove a mutable `withdrawn_at` edit cannot make an event-withdrawn publication
  public.

### Production guard

- In production mode, queue and detail guards return not found before opening a
  database.
- In production mode, every mutation rejects before opening a transaction.
- Verify statements, publications, and event counts remain unchanged.

## Browser Journeys

### Full publication lifecycle

1. Run clean deterministic fixture preparation.
2. Open `/review` at desktop width.
3. Verify all eight labelled phase links and counts render. Filter to
   `Needs review` and open the reserved lifecycle statement through the only row
   action, `Inspect evidence`; verify no queue control can mutate state.
4. Inspect Statement, Evidence, Extraction, Normalized Content, and Source
   Snapshot in that order.
5. Submit `Ready to approve` with a private note.
6. Approve with a reason.
7. Publish and confirm the described public effect.
8. Open the public candidate page and verify the exact frozen statement appears.
   Navigation uses the current tab; browser Back restores the review detail and
   prior queue-filter context.
9. Unpublish with a required reason.
10. Reload the public page and verify the statement and all private sentinels are
    absent.
11. Verify the detail history is chronological, human-readable, and append-only.

### Changes requested and rejection

1. Open the second reserved `Needs review` statement.
2. Submit `Changes requested` with a reason.
3. Reject it with a distinct reason.
4. Verify it appears under the rejected filter and exposes no further actions.
5. Verify its statement, both reasons, and operator sentinel are absent publicly.

### Error and replay journeys

- Double-submit one action and verify one success result/history row.
- Submit from a stale second tab and verify the conflict summary, focus target,
  reload affordance, and unchanged state.
- Submit empty and over-limit inputs and verify labelled field errors.
- Visit an unknown review statement and verify not found.
- Reveal public-change confirmation and verify focus moves to its heading;
  Cancel and Escape restore focus to the reveal control; success focuses the
  status heading; stale/validation errors focus the error summary.

## Accessibility and Responsive Checks

- Complete both browser journeys with keyboard only.
- Verify visible focus on links, disclosure controls, form fields, filters, and
  buttons.
- Verify one page heading, logical heading order, labelled controls, field error
  associations, error-summary focus, live status announcements, and descriptive
  button names.
- Verify 320×800, 768×1024, and 1440×900 layouts plus 400% reflow without
  horizontal scrolling, clipped evidence, overlapping controls, or inaccessible
  sticky UI.
- At 320px/400% reflow, verify all eight filter links wrap and remain visible
  without page-level or filter-container horizontal scrolling.
- Verify the global skip link is the first focusable control and targets an
  existing `#main-content` on both public and review pages.
- Verify Statement and Evidence are initially open; Extraction, Normalized
  content, and Source snapshot are initially collapsed; any blocking status
  remains visible while their details are closed.
- Measure the semantic review token pairs and require at least 4.5:1 contrast:
  `#7a271a` on `#f8e7e3` and `#664d03` on `#fff3cd`, plus their inverse/interactive
  use where applicable.
- Inspect browser console on every journey and fail on uncaught errors, hydration
  warnings, or failed requests.

## Fixture Reset Proof

1. Run `npm run db:prepare` and record exact row counts, phases, event digests,
   and public response.
2. Complete the publication/unpublication and rejection journeys.
3. Run `npm run db:prepare` again.
4. Verify the recorded baseline is restored byte-for-byte where serialized and
   value-for-value in database queries.
5. Verify no path outside the exact fixture database directory was removed or
   modified.

## Required Commands

```powershell
npm run db:prepare
npm run check
npm run test:e2e
git diff --check
git status --short --branch
```

`npm run check` must include lint, type checking, the full Vitest suite with the
existing coverage thresholds, and a production build. Browser tests must start
from a freshly prepared deterministic database.

## Pass Gate

PASS requires every test above, a clean production build, no browser console
errors, deterministic fixture replay, no unexplained git changes, and no public
or production mutation. A failure in migration integrity, transition atomicity,
public privacy, append-only history, production guarding, or accessibility
blocks commit and draft PR creation.
