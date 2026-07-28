# Municipal Election Explorer

A neutral, evidence-first local proof for the 2026 Chatham-Kent municipal
election. It demonstrates one complete path from saved public campaign material
to an immutable, evidence-backed candidate statement, preceded by a preserved
official roster import and an explicitly reviewed source discovery.

The included candidacy and campaign text are synthetic. No live website, model
API, credential, or production database is used.

## Run locally

Requirements: Node.js 20.9 or newer and npm.

```powershell
npm install
npm run db:prepare
npm run dev
```

Open:

- `http://localhost:3000/`
- `http://localhost:3000/candidates/demo-candidate`
- `http://localhost:3000/review`

The demo database is file-backed under `.data/` and can be rebuilt
deterministically from the committed fixtures. The review workspace is a
development-only fixture tool: it returns 404 and rejects its server actions
before database access when `NODE_ENV=production`.

## Verify

```powershell
npm run check
npx playwright install chromium
npm run test:e2e
```

`npm run check` runs lint, TypeScript, the Vitest behavior/coverage suite, and a
production Next.js build. Playwright separately verifies the rendered evidence
journey and 404 behavior.

To verify an already-running local server without starting a second Next.js
process:

```powershell
$env:PLAYWRIGHT_BASE_URL = "http://127.0.0.1:3101"
$env:PLAYWRIGHT_REUSE_EXISTING_SERVER = "1"
npm run test:e2e
```

## What the slice proves

- election-scoped candidacy import is idempotent;
- exact official roster bytes, their hash, source, observation time, and linked
  candidacy-status observations are preserved;
- official person keys are reconciled across later imports, and one status
  observation cannot silently claim provenance from two import runs;
- discovery records remain proposed until an explicit accept/reject decision,
  and only an accepted candidate-owned website becomes capturable;
- candidate-owned links are canonical credential-free HTTP(S) URLs, and fixture
  capture cannot substitute an unrelated original URL;
- a saved HTML source produces immutable raw bytes, a SHA-256 snapshot, and
  stable normalized blocks;
- structured extraction must bind an exact quote and UTF-16 offsets to a block;
- source ownership and attribution policy are enforced again at publication;
- ambiguous material is retained as an abstention, not published;
- editorial review, approval, rejection, publication, and unpublication are
  separate guarded transitions with append-only event history;
- browser-submitted operator identity is ignored in favor of a server-owned
  synthetic fixture identity;
- publishing requires the current evidence subject digest to match the immutable
  approval event, then freezes a canonical, hash-verified publication snapshot;
- active public output is selected only from immutable publish/unpublish events,
  while publication payload identity, content, digest, and publish time are
  protected against update or deletion;
- drafts, raw captures, raw extraction output, official import payloads, and
  discovery evidence, private review notes, operator references, and editorial
  history are absent from public queries;
- completed, URL-bound source coverage gates the stronger “No explicit public
  statement found” wording;
- later official candidacy-status observations are retained and reflected in
  the public record;
- pgvector is installed and migration-ready, but no embeddings are generated.

See [VISION.md](./VISION.md) for the evidence policy and
[ARCHITECTURE.md](./ARCHITECTURE.md) for the longer-term system design.

## Deliberately absent

There is no live Chatham-Kent import, crawler, social adapter, live AI call,
search, authentication, deployment, production review access, or public
publication in this slice. The included review UI operates only on deterministic
local fixture data.
