# Website digest — design plan

A tool that tracks a list of websites, scrapes them once a day, processes the content with an
LLM (OpenAI Batch API) and publishes a single static digest page to S3.

Built on the existing scaffold: Temporal for scheduling and durable waits, S3 for raw content
and the published page, Postgres (schema per context), and the `notifications` context for
optional alerts. Follows the conventions in [`AGENTS.md`](../AGENTS.md).

## Requirements (decided)

| Topic | Decision |
|---|---|
| Users | Single user now, multi-user later — keep `ownerId` in the model from day one |
| Source kinds | RSS/Atom feeds, listing pages → articles, single-page change watch, JS-rendered sites |
| Source management | HTTP API (CRUD); an admin panel comes later |
| Cadence | Everything once a day |
| AI processing | Per-item summary, relevance filtering/ranking by interests, cross-source clustering & dedupe, editorial overview |
| LLM | OpenAI **Batch API** (cost); results may take up to 24h → **publish when ready** |
| Clustering | Embeddings + cosine similarity, computed in code |
| Delivery | Static HTML page uploaded to S3, **single latest page** (overwritten each run) |
| Hosting | Out of scope — the tool only uploads to a configurable bucket/key |
| Retention | Keep raw HTML + extracted text in S3 (optional lifecycle expiry) |

## Bounded contexts

| Context | Owns | Task queue(s) |
|---|---|---|
| **`sources`** (new) | Source catalogue, scraping, items, page snapshots, raw content (`sources/…`) | `sources`, `sources-browser` |
| **`digests`** (new) | Interest profile, AI enrichment, clustering, digest runs, rendering, publishing (`digests/…`) | `digests` |
| `notifications` (existing) | Optional "digest published / failed" alerts | `notifications` |

**Why two contexts:** source configuration and crawl state change together, while relevance and
summaries depend on a (future per-user) interest profile. With multiple users, `sources` stays
unchanged and shared; each user gets their own profile and digest over the same items.

**Hand-off (claim check):** a day's article text is several MB — too large for Temporal
workflow history. The `sources` child workflow writes a JSONL export to
`sources/exports/<runId>.jsonl` and returns its key. The key and the line schema
(`ExportedItem`) are declared in `sources/contracts`, so they are published language;
`digests` reads that file and nothing else from `sources`.

## Daily flow

```
Temporal Schedule "daily-digest" (cron + timezone from config)
└─ dailyDigestWorkflow(runId = "2026-10-21")                      [digests]
   1. executeChild collectSourcesWorkflow({ runId })              [sources]
        listEnabledSources → collectSource(id, runId) per source
          (bounded concurrency; a failing source never fails the run)
          HTTP sources on `sources`, browser sources on `sources-browser`
        exportItems(runId) → { exportKey, itemCount, failedSources[] }
   2. submitEnrichment: 2 OpenAI batches in parallel
        a) chat: per item → { summary, relevance 0..1, reason, tags } (structured output)
        b) embeddings: per item
   3. wait loop: checkBatch → sleep('10m') (durable timer) until done (≤24h)
   4. ingestEnrichment: store results; failed lines → one retry batch, then skip the item
   5. cluster (pure domain function): drop low relevance, group by cosine similarity
   6. submitSynthesis batch: per-cluster headline + editorial overview
      (overview is written from per-item summaries, so it doesn't wait on cluster headlines)
      → wait loop → ingest
   7. render HTML → publish to S3 (skip if a newer run has already published)
   8. (optional) executeChild sendNotificationWorkflow
```

Typical runs take two batch round-trips: usually minutes to a few hours, worst case about 48h.
Workflow ID is `digest-<runId>`, so starting the same day twice is idempotent.

## `sources` context

### Domain

- **`Source`** aggregate
  - `id`, `ownerId` (defaults to `'default'`), `name`, `url`
  - `kind`: `'feed' | 'listing' | 'page'`
  - `fetchMode`: `'http' | 'browser'`
  - per-kind config: `listing: { linkSelector?, urlPattern? }`, `page: { contentSelector? }`
  - `enabled`, `consecutiveFailures`, `lastCollectedAt`
  - Invariants: kind-specific config matches `kind`; URL is http(s).
  - Methods: `create`, `update`, `enable`/`disable`, `recordSuccess(now)`, `recordFailure(reason, now)`.
- **`Item`**
  - Deterministic ID: `hash(sourceId + canonicalUrl)`; for page changes `hash(sourceId + contentHash)`.
    Collecting is therefore idempotent (unique constraint).
  - `title`, `url`, `publishedAt`, `discoveredAt`, `rawKey`, `textKey`, optional `diff`,
    `exportedInRun`.
- **`PageSnapshot`**: last content hash and text key per page-watch source.
- **Baseline rule:** the first collection of a feed or listing only records the items it finds
  as already seen, so day one isn't flooded with old articles.

### Ports & adapters

- `PageFetcher`
  - `undici` adapter: conditional GET (ETag / If-Modified-Since), timeout, max bytes, User-Agent.
  - Playwright adapter: runs only on the `sources-browser` worker, so Chromium is a separate
    deployable.
  - Blocks private/loopback IP ranges (SSRF protection — URLs come from the API).
- `Extractor`s
  - feed: RSS/Atom parser
  - listing: link discovery (cheerio + selector / URL pattern)
  - article: `@mozilla/readability` + `linkedom`
  - page watch: normalise text → hash → text diff against the last snapshot
- `RawContentStore` (S3): `sources/raw/<sourceId>/<date>/<itemId>.{html,txt}`
- `ItemExporter` (S3): `sources/exports/<runId>.jsonl`
- Kysely repositories for sources, items, snapshots (schema `sources`).

### Export semantics

Export selects items where `exportedInRun IS NULL OR exportedInRun = runId`, tags them with the
run ID and writes the JSONL. Re-running the same run yields the same export; items from a run
that failed before export are picked up by the next one.

### HTTP

- `POST/GET/PATCH/DELETE /sources`, `GET /sources/:id`
- `GET /sources/:id/items`
- `POST /sources/preview` — fetch + extract a URL without persisting; used to tune selectors.

### Contracts (`sources/contracts/index.ts`)

`SOURCES_TASK_QUEUE`, `COLLECT_SOURCES_WORKFLOW`, `CollectSourcesInput { runId }`,
`CollectSourcesResult { exportKey, itemCount, failedSources[] }`, `ExportedItem`
(JSONL line: `itemId, sourceId, sourceName, kind, url, title, publishedAt, text, diff?`),
`CollectSourcesWorkflow` function type.

## `digests` context

### Domain

- **`InterestProfile`**: `ownerId`, free-text interests, relevance threshold.
- **`Digest`** aggregate
  - status: `collecting → enriching → synthesizing → rendering → published | failed`
  - batch IDs per stage (resubmission reuses an existing batch → idempotent)
  - stats: item counts, failed sources, token usage, cost
- **`ItemAnalysis`**: summary, relevance, reason, tags, embedding.
- **Clustering**: pure function in `domain/` — greedy grouping above a configurable cosine
  threshold. Deterministic, unit-tested.

### Ports (`application/ports.ts`) & adapters

- `BatchLlm`: `submit(requests, idempotencyKey) → handle`, `status(handle)`, `results(handle)`
  - `OpenAiBatchLlm` (`openai` SDK): upload JSONL, create batch, retrieve, download output
    and error files. `custom_id` = `<itemId>:<task>`. One endpoint per batch file, so chat and
    embeddings are separate batches.
  - `StubBatchLlm` (`LLM_PROVIDER=stub`): completes instantly, so `pnpm dev` works end to end
    without cost.
- `ExportedItemsReader`: reads the claim-check JSONL.
- `DigestPublisher` (S3): `PutObject` to the configured bucket/key, `text/html`, short
  `Cache-Control`. Publishing only moves forward: a run older than the last published one
  does not overwrite the page.
- Kysely repositories for digests, analyses and profile (schema `digests`).

### Rendering

Pure `Digest snapshot → HTML` function in infrastructure. Escapes all model and scraped text;
inline CSS, no JS. Layout:

1. editorial overview
2. clusters: headline, item summaries, links to originals
3. "Also noted": headlines of low-relevance items
4. footer: date, failed sources, cost

### HTTP

- `GET/PUT /profile`
- `GET /digests`, `GET /digests/:id` (status + stats)
- `POST /digests/runs` — manual trigger

## Shared infrastructure changes

- **Config** (`loadConfig`): `OPENAI_API_KEY`, `OPENAI_ITEM_MODEL`, `OPENAI_SYNTHESIS_MODEL`,
  `OPENAI_EMBEDDING_MODEL`, `LLM_PROVIDER` (`openai | stub`), `DIGEST_CRON`,
  `DIGEST_TIMEZONE`, `DIGEST_PUBLISH_BUCKET`, `DIGEST_PUBLISH_KEY`, `BROWSER_FETCH_ENABLED`.
- **OpenAI client factory** in `shared/infrastructure` (technical plumbing, like the S3 client).
- **Schedules**: extend `ModuleDefinition` with optional `schedules(deps)`; the worker upserts
  them idempotently at startup. This changes the shared contract.
- **Browser worker**: `sources-browser` queue runs only when `BROWSER_FETCH_ENABLED=true`;
  add Playwright browsers to the Nix flake.

## Delivery phases

Each phase ends with a usable digest. Detailed task breakdown:
[`website-digest-phases.md`](website-digest-phases.md).

1. **`sources` with RSS only** — CRUD, collect, raw content to S3, export, preview endpoint.
2. **`digests` end to end** — schedule, `BatchLlm` adapter + stub, summarize & score, render,
   publish. No clustering yet.
3. **Clustering & synthesis** — embeddings batch, clustering, overview batch.
4. **More source kinds** — listing pages with Readability, page watch with diffs.
5. **JS-rendered sites** — Playwright fetcher, `sources-browser` queue.
6. **Hardening** — retry batch for failed lines, cross-day dedupe (skip stories already
   reported, using stored embeddings), failure notifications, multi-user (subscriptions +
   profile per user).

## Defaults (open to change)

- Baseline on first collection: **on**.
- Low-relevance items: headlines only under "Also noted", not dropped.
- Article text truncated to ~4k tokens per item before the LLM, to control cost.
- Digest language: English.
- Schedule timezone: from config.
- Overlapping runs: a day still waiting on its batch doesn't block the next day; publishing
  only moves forward in time.
