# Municipal Election Explorer

A neutral, evidence-first local proof for the 2026 Chatham-Kent municipal
election. It demonstrates one complete path from saved public campaign material
to an immutable, evidence-backed candidate statement.

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

The demo database is file-backed under `.data/` and can be rebuilt
deterministically from the committed fixtures.

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
- a saved HTML source produces immutable raw bytes, a SHA-256 snapshot, and
  stable normalized blocks;
- structured extraction must bind an exact quote and UTF-16 offsets to a block;
- source ownership and attribution policy are enforced again at publication;
- ambiguous material is retained as an abstention, not published;
- an approved statement becomes a canonical, hash-verified publication payload;
- drafts, raw captures, and raw extraction output are absent from public queries;
- completed, URL-bound source coverage gates the stronger “No explicit public
  statement found” wording;
- later official candidacy-status observations are retained and reflected in
  the public record;
- pgvector is installed and migration-ready, but no embeddings are generated.

See [VISION.md](./VISION.md) for the evidence policy and
[ARCHITECTURE.md](./ARCHITECTURE.md) for the longer-term system design.

## Deliberately absent

There is no live Chatham-Kent import, crawler, social adapter, live AI call,
review UI, search, authentication, deployment, or public publication in this
slice.
