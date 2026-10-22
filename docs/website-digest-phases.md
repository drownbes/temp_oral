# Website digest — implementation phases

Step-by-step build plan for the design in [`website-digest-plan.md`](website-digest-plan.md).
Each phase is one or a few PRs, ends with something runnable, and passes `pnpm check` and
`pnpm test:integration`. Paths are relative to `src/modules/<context>/` unless they start with
`src/`.

Order inside a phase follows the `AGENTS.md` recipes: domain + tests → use cases + tests with
fakes → adapters + integration tests → interface (HTTP / Temporal) → wiring in `index.ts`.

## Overview

| # | Phase | Delivers | Depends on |
|---|---|---|---|
| 1 | `sources` with RSS | Manage feeds via API, collect them, raw content in S3, JSONL export | — |
| 2 | `digests` end to end | Daily schedule → OpenAI batch summaries + relevance → HTML page in S3 | 1 |
| 3 | Clustering & synthesis | Embeddings, cross-source clusters, editorial overview | 2 |
| 4 | Listing pages & page watch | Article discovery + Readability, page change diffs | 1 (2 for digest output) |
| 5 | JS-rendered sites | Playwright fetcher on its own `sources-browser` queue | 4 |
| 6 | Hardening | Retries, cross-day dedupe, notifications, source health, cost | 3, 4 |
| 7 | Multi-user (later) | Subscriptions, per-user profile/digest, auth | 6 |

Phases 3 and 4 are independent and can run in parallel after phase 2.

## Design notes that affect every phase

- **Deterministic IDs without imports.** Domain code may not import `node:crypto`, but the
  global Web Crypto API is fine (as `crypto.randomUUID()` already is), so `itemIdFor()` in
  `domain/item.ts` derives a UUIDv8 from `sha256(sourceId, canonicalUrl)`. No `Hasher` port.
  URL canonicalisation uses the global `URL` and stays in the domain.
- **No zod in `application/`.** Application code may not import npm packages. Anything that
  parses untrusted shapes (feed XML, LLM JSON) does so in the adapter and returns typed
  values to the use case.
- **Task-oriented LLM ports.** Prompts and structured-output schemas live in the OpenAI
  adapter. Use cases see `ItemAnalyzer`, `ItemEmbedder` and `DigestSynthesizer`, each with
  `submit → status → results`. Swapping providers or prompts never touches use cases.
- **Run IDs are dates** (`YYYY-MM-DD` in `DIGEST_TIMEZONE`). Scheduled runs derive the date
  from the scheduled start time; manual runs pass it explicitly. One digest per date: there is
  a unique constraint, and the workflow ID is `digest-<runId>`.

---

## Phase 1 — `sources` context, RSS/Atom only

**Goal:** register feeds through the API, collect them on demand, store raw and extracted
content in S3, and produce the JSONL export that `digests` will consume.

> **Status: done.** How the implementation differs from the plan below:
> - No `Hasher` port (see the design notes); `planCollection` is split into `uniqueEntries` +
>   `planCollection` so known URLs can be looked up between them.
> - Run assignment is an atomic repository operation, `ItemRepository.claimForRun(runId)`
>   (one `UPDATE … WHERE exported_in_run IS NULL`). It's safe when runs overlap, so there is no
>   domain `assignToRun` method.
> - The feed reader is `extract/feedsmith-feed-reader.ts` (feedsmith 3: RSS, Atom, RDF,
>   JSON Feed), with a small regex `html-text.ts` for entry HTML. Phase 4 brings a DOM extractor.
> - Concurrency is the `COLLECT_CONCURRENCY` constant in `interface/temporal/definitions.ts`
>   (a workflow can't read config) and works as a pool, not fixed chunks.
> - `listCollectableSources(runId)` validates the run id, so a bad id fails the run up front
>   instead of recording a failure for every source.
> - Fetch config: `FETCH_TIMEOUT_MS` defaults to 15000. The address guard checks literal IPs on
>   every redirect hop and resolved IPs at connect time (DNS rebinding).
> - Fetcher and feed reader tests are self-contained unit tests (a local `node:http` server and
>   fixtures); Postgres and S3 adapters have `*.int.test.ts`.

### Domain (`domain/`)

- `source.ts`: `Source` aggregate, `SourceId` brand, `newSourceId()`.
  - `kind: 'feed' | 'listing' | 'page'` and `fetchMode: 'http' | 'browser'` are modelled
    fully now. The create use case rejects unsupported combinations until phases 4/5
    (`SourceKindNotSupportedError`).
  - Fetch state: `etag`, `lastModified`, `lastCollectedAt`, `consecutiveFailures`,
    `lastError`, `baselinedAt`.
  - Methods: `create`, `rename`, `reconfigure`, `enable`, `disable`, `recordSuccess`,
    `recordFailure`, `markBaselined`.
- `item.ts`: `Item` aggregate, `ItemId` brand, `canonicalizeUrl()` (drops fragments and
  tracking params, sorts the query string).
  - Fields: `baseline: boolean` (seen during the first collection, never exported) and
    `exportedInRun`.
- `collection.ts`: pure `planCollection(source, discovered, knownUrls)` → the items to
  create, each flagged as baseline or not.
- `errors.ts`: `SourceNotFoundError`, `InvalidSourceConfigError`,
  `SourceKindNotSupportedError`, `DuplicateSourceError` (conflict on `ownerId + url`).
- `source-repository.ts`, `item-repository.ts`: ports.
- Tests: `source.test.ts`, `item.test.ts` (canonicalisation), `collection.test.ts` (baseline).

### Application (`application/`)

- `ports.ts`:
  - `PageFetcher.fetch(url, { etag, lastModified })` → `{ status: 'ok' | 'not-modified', body, contentType, etag, lastModified, finalUrl }`
  - `FeedReader.read(body, baseUrl)` → `FeedEntry[]`
  - `RawContentStore.put(sourceId, date, itemId, { html, text })` → keys
  - `ItemExporter.write(runId, items)` → `exportKey`
  - `Hasher.hash(parts)`
- Use cases, one file each:
  - `create-source`, `update-source`, `delete-source` (archives; items are kept)
  - `get-source`, `list-sources`, `list-source-items`
  - `preview-source`: fetch + extract without persisting
  - `collect-source(sourceId, runId)`: idempotent; items get unique deterministic IDs,
    raw objects are overwritten, failures are recorded on the source
  - `list-collectable-sources`
  - `export-items(runId)`: selects `exportedInRun IS NULL OR = runId` and excludes baseline
    items. Idempotent.
- `testing/fakes.ts`: in-memory repositories, fetcher with canned responses, exporter.
- Tests: `collect-source.test.ts` (first run baselines, second run adds only new entries,
  not-modified short-circuits, failures recorded), `export-items.test.ts` (re-export of the
  same run is identical, leftovers from a failed run are picked up).

### Infrastructure (`infrastructure/`)

- `persistence/tables.ts` (schema `sources`), `migrations/0001_create_source.ts`,
  `0002_create_item.ts`
  - Unique `(owner_id, url)` on sources; unique `(source_id, canonical_url)` on items.
- `persistence/kysely-source-repository.ts`, `kysely-item-repository.ts` + `*.int.test.ts`.
- `fetch/undici-page-fetcher.ts` + `*.int.test.ts` against a local `node:http` fixture server
  - timeout, max bytes, User-Agent, conditional GET, redirect limit
  - SSRF guard: resolve DNS and reject private/loopback/link-local addresses. Tests and dev
    set `FETCH_ALLOW_PRIVATE_NETWORKS=true`.
- `extract/feed-reader.ts`: RSS 2.0 / Atom / RDF via a feed-parsing library (pick in this
  phase; candidates `feedsmith`, `fast-xml-parser`) + `test/fixtures/feeds/*.xml` and
  `*.test.ts`.
- `storage/s3-raw-content-store.ts`: `sources/raw/<sourceId>/<date>/<itemId>.{html,txt}`.
- `storage/s3-item-exporter.ts`: `sources/exports/<runId>.jsonl` + `*.int.test.ts`.
- `crypto-hasher.ts`: sha256 → base32, truncated.

### Contracts (`contracts/index.ts`)

`SOURCES_TASK_QUEUE`, `COLLECT_SOURCES_WORKFLOW`, `CollectSourcesInput`,
`CollectSourcesResult`, `ExportedItem`, `CollectSourcesWorkflow`.

### Interface (`interface/`)

- `http/routes.ts` (`async function sourcesHttp(app)`):
  - `POST /sources`, `GET /sources`, `GET /sources/:id`, `PATCH /sources/:id`,
    `DELETE /sources/:id`
  - `GET /sources/:id/items`
  - `POST /sources/preview`
  - `POST /sources/collect { runId }`: manual run, for development until phase 2
- `temporal/activities.ts`: `listCollectableSources`, `collectSource`, `exportItems`.
- `temporal/workflows.ts`: `collectSourcesWorkflow`
  - Runs `collectSource` with bounded concurrency (chunks of `concurrency`, passed in the
    input).
  - Per-source failure (after activity retries) goes into `failedSources` and the run
    continues.
- `temporal/workflows.test.ts`: one failing source doesn't fail the run; the export is
  called once.

### Wiring & config

- `index.ts` (`sourcesModule`), register in `src/main/modules.ts`.
- Config: `FETCH_TIMEOUT_MS` (10000), `FETCH_MAX_BYTES` (5 MB), `FETCH_USER_AGENT`,
  `FETCH_ALLOW_PRIVATE_NETWORKS` (false; true in `.env.development`), `COLLECT_CONCURRENCY` (4).

### Done when

```sh
curl -XPOST localhost:8080/sources -d '{"name":"HN","kind":"feed","url":"https://hnrss.org/frontpage"}'
curl -XPOST localhost:8080/sources/collect -d '{"runId":"2026-10-21"}'   # first run: baseline
curl -XPOST localhost:8080/sources/collect -d '{"runId":"2026-10-22"}'   # only new entries exported
curl localhost:8080/sources/<id>/items
```

- Raw `.html`/`.txt` objects and `sources/exports/2026-10-22.jsonl` exist in the dev bucket.
- Running the same `runId` twice produces an identical export.
- The trace shows HTTP → workflow → per-source activities → fetch/S3/Postgres.

---

## Phase 2 — `digests` context end to end (summaries + relevance)

**Goal:** a schedule fires daily, collects sources, sends items through an OpenAI batch for
summary + relevance, and publishes a single HTML page to S3. A stub LLM makes it work locally
without cost.

> **Status: done** (verified end to end with the stub and with the real OpenAI Batch API).
> How the implementation differs from the plan below:
> - The workflow is a loop driven by the digest's persisted status. Re-running a day resumes
>   it (e.g. keeps waiting for the same batch) instead of starting over. A failed digest
>   restarts from collection.
> - Status `superseded` was added: a digest that finishes after a newer day was published
>   does not overwrite the single page.
> - Items are stored as `digest_entry` rows: one per collected item, with analysis or failure
>   reason. `item_analysis` is a value inside an entry. Partial batches (expired/cancelled)
>   still publish, and items without analysis are listed by title.
> - Batch idempotency: batches carry `metadata.idempotency_key`. `submit` reuses a live batch
>   with the same key, so a crash between submitting and saving doesn't pay twice.
> - Not built (not needed yet): `OPENAI_SYNTHESIS_MODEL` / `OPENAI_EMBEDDING_MODEL` (phase 3),
>   and `DIGEST_BATCH_POLL_INTERVAL`. Instead, polling backs off: the batch is checked after 1,
>   2 and 5 minutes, then every 10 (`BATCH_POLL_INTERVALS`, a constant because a workflow
>   can't read config; tests override it through the input). Small batches show up within
>   minutes; a 24h wait costs about 150 cheap status checks.
> - Verified against the real API (2026-10-21): 29 Phoronix items, `gpt-6-luna` through the
>   Batch API, all analysed, 12.9k input / 3.7k output tokens (about $0.002), batch done in
>   under 10 minutes.
> - `ModuleDeps` gained `openai`; `ModuleDefinition` gained `schedules`, upserted by the
>   worker at startup (startup fails on an invalid schedule).
> - The default item model is `gpt-6-luna` (OpenAI's recommendation for cost-sensitive,
>   high-volume work as of Oct 2026; batch $0.05 / $0.25 per 1M input/output tokens). It's a
>   reasoning model, so `OPENAI_REASONING_EFFORT` (default `low`) is sent as
>   `reasoning_effort`; set `omit` for a model without reasoning.

### Shared infrastructure

- `config.ts`:
  - `LLM_PROVIDER` (`openai` | `stub`, default `openai`; `stub` in `.env.development`)
  - `OPENAI_API_KEY` (required when the provider is `openai`; zod refine)
  - `OPENAI_ITEM_MODEL`, `OPENAI_SYNTHESIS_MODEL`, `OPENAI_EMBEDDING_MODEL`
  - `DIGEST_CRON` (`0 6 * * *`), `DIGEST_TIMEZONE` (`UTC`)
  - `DIGEST_PUBLISH_BUCKET` (defaults to `S3_BUCKET`), `DIGEST_PUBLISH_KEY`
    (`digests/latest/index.html`)
  - `DIGEST_BATCH_POLL_INTERVAL` (`10m`), `DIGEST_MAX_ITEM_CHARS` (16000)
- `openai/openai.ts`: client factory. Add `openai` to `ModuleDeps` only if the provider is
  `openai`; otherwise leave it undefined so adapters fail fast.
- `module.ts`: add `schedules?: (deps) => ScheduleDefinition[]`.
  `src/main/worker-runtime.ts` upserts each one at startup (create; on already-exists,
  update), so the schedule follows config.

### Domain

- `interest-profile.ts`: `InterestProfile` (one per `ownerId`): `interests` text,
  `relevanceThreshold`.
- `digest.ts`: `Digest` aggregate, `DigestId`, `runId`, `ownerId`.
  - Status: `collecting → enriching → rendering → published | failed`; `synthesizing` is
    added in phase 3.
  - Methods: `collected(exportKey, counts, failedSources)`, `enrichmentSubmitted(batchRef)`,
    `enrichmentCompleted`, `published(at)`, `fail(reason)`.
  - Stats: item counts, failed sources, token usage.
- `item-analysis.ts`: `ItemAnalysis` (`itemId`, `summary`, `relevance`, `reason`, `tags`).
- `ranking.ts`: pure `rankForDigest(analyses, threshold)` → `{ featured, alsoNoted }`.
- Errors, repository ports, tests for every transition and the ranking rule.

### Application

- `ports.ts`:
  - `ItemAnalyzer`: `submit(key, inputs, profile)`, `status(ref)`, `results(ref)`
  - `ExportedItemsReader.read(exportKey)`
  - `DigestPublisher.publish(view)`
  - `DigestRunStarter.start(runId)`
- Use cases:
  - `get-profile`, `update-profile`
  - `start-digest-run`
  - `begin-digest(runId)`: idempotent create
  - `record-collection`
  - `submit-enrichment`: reuses the stored batch ref when one exists
  - `check-enrichment`, `ingest-enrichment`
  - `publish-digest`: skips when a newer `runId` is already published
  - `mark-digest-failed`, `get-digest`, `list-digests`
- Fakes + tests: resubmission doesn't create a second batch; an older run doesn't overwrite
  a newer published page.

### Infrastructure

- `persistence/`: schema `digests`
  - `0001_create_interest_profile.ts`, `0002_create_digest.ts` (unique `owner_id, run_id`),
    `0003_create_item_analysis.ts`
  - repositories + int tests
- `llm/openai-batch-client.ts`: generic JSONL upload → `batches.create` → `retrieve` →
  download output/error files. It's the only file that knows about Batch API mechanics.
- `llm/openai-item-analyzer.ts`: prompt, JSON schema for structured output, zod parsing of
  each line; malformed lines come back as per-item failures.
- `llm/stub-item-analyzer.ts`: completes immediately with deterministic fake output.
- `storage/s3-exported-items-reader.ts`: reads the key from the `sources` contract.
- `publishing/html-renderer.ts`: pure function, escapes all text. `html-renderer.test.ts`
  covers structure and XSS escaping.
- `publishing/s3-digest-publisher.ts`: renders, then `PutObject` (`text/html; charset=utf-8`,
  `Cache-Control: max-age=300`) + int test.
- `temporal/temporal-digest-run-starter.ts`.

### Interface

- `http/routes.ts`: `GET/PUT /profile`, `GET /digests`, `GET /digests/:id`,
  `POST /digests/runs { runId? }`.
- `temporal/workflows.ts`: `dailyDigestWorkflow`
  1. derive `runId` (input, or the scheduled start time in the timezone)
  2. `beginDigest`
  3. `executeChild<CollectSourcesWorkflow>` on `SOURCES_TASK_QUEUE`
  4. `recordCollection`
  5. if there are zero items → publish an "all quiet" page and stop
  6. `submitEnrichment`
  7. loop `checkEnrichment` / `sleep(pollInterval)` until done
  8. `ingestEnrichment`
  9. `publishDigest`

  Any failure → `markDigestFailed` and rethrow.
- `temporal/workflows.test.ts`: time-skipping environment, fake activities. Covers a batch
  that needs several polls, zero items, and a child workflow failure.
- `schedules`: `daily-digest`, cron + timezone from config, overlap policy `ALLOW_ALL`.

### Done when

- With `LLM_PROVIDER=stub`, `POST /digests/runs` → `digests/latest/index.html` appears in the
  dev bucket and opens in a browser.
- With a real key, a run submits a batch (visible in the OpenAI dashboard), waits through
  durable timers (visible in the Temporal UI) and publishes.
- The `daily-digest` schedule shows up in the Temporal UI after the worker starts.

---

## Phase 3 — clustering & editorial synthesis

**Goal:** merge items about the same story across sources and add an overview at the top.

> **Status: done** (verified with the real OpenAI Batch API on 51 items from Phoronix,
> 9to5Linux and LinuxGizmos). How the implementation differs from the plan below:
> - **One item per source per story.** On real data, articles of the *same* source on the
>   same topic (Linux 7.4 XFS vs. Btrfs updates, two e-paper kits) embed as close as, or
>   closer than, the same story across sources (COSMIC 1.11 on Phoronix vs. 9to5Linux: 0.649).
>   Restricting a story to one item per source removes those false merges; among cross-source
>   pairs the data separated cleanly (true ≥ 0.649, false ≤ 0.619). The lead takes the
>   *most similar* item of each other source.
> - Threshold `DIGEST_CLUSTER_THRESHOLD` defaulted to **0.63** here, later raised to 0.75 (text-embedding-3-small at 512
>   dimensions). The margin was thin on the first sample; revisit with more days of data
>   (`GET /digests/:id` shows the stories; similarities can be recomputed from
>   `digest_entry.embedding`).
> - The two enrichment batches (analysis, embeddings) are submitted together and polled
>   together; synthesis is a third batch (merged story texts + overview in one). With nothing
>   to synthesise, it completes without a batch. A failed embeddings or synthesis batch
>   degrades the page (no grouping / no overview) instead of failing the digest.
> - Embedding input is the title plus the first 4,000 characters of text, 512 dimensions,
>   stored as `real[]` on `digest_entry` (no pgvector yet).
> - Clusters live in the digest (`clusters` jsonb, lead item first); the column `batch_ref`
>   became `analysis_batch_ref` (migration `0004_add_stories`).
> - Cost on the test: 51 items, three batches, about $0.0034 in total.
> - **`OPENAI_API_MODE=batch|direct`.** A synthesis batch of 4 requests sat at 3/4 for 30+
>   minutes, then hung in `cancelling`: batch latency is unpredictable. `direct` runs the same
>   requests through the normal API (full price, `OPENAI_DIRECT_CONCURRENCY` at a time) and
>   stores the results in S3 (`digests/llm-results/`) in the Batch API's output format, so the
>   analyzers are unchanged and retries don't pay twice. Refs say which mode made them
>   (`direct:` prefix), so switching modes never orphans a running batch. The same 51-item
>   run took 38 seconds in direct mode (about $0.006). Default stays `batch` for production.

- **Domain:**
  - `clustering.ts`: `cosineSimilarity`, greedy `clusterItems(items, threshold)` (seeded by
    relevance, deterministic tie-breaks) + tests.
  - `Digest` gains the `synthesizing` status, a second batch ref, `clusters`, `overview`.
- **Application:**
  - ports `ItemEmbedder` and `DigestSynthesizer` (same `submit/status/results` shape)
  - use cases `submit-embeddings`, `check-embeddings`, `ingest-embeddings`,
    `cluster-digest`, `submit-synthesis`, `check-synthesis`, `ingest-synthesis`
- **Infrastructure:**
  - `llm/openai-item-embedder.ts` (`/v1/embeddings` batch)
  - `llm/openai-digest-synthesizer.ts`: one request per multi-item cluster for its headline,
    plus one overview request built from per-item summaries
  - stub versions of both
  - migration `0004_add_embedding_and_clusters.ts` (embedding as `real[]`; pgvector not
    needed yet)
- **Workflow:** wait for the enrichment and embeddings batches in parallel
  (`Promise.all` of two wait loops) → `clusterDigest` → synthesis batch → wait → ingest
  → publish.
- **Renderer:** overview, clusters with headline + member summaries + source links,
  "Also noted".
- **Config:** `CLUSTER_SIMILARITY_THRESHOLD` (start at 0.82 and tune on real data).
- **Done when:** two feeds covering the same story show up as one cluster with both links,
  and the page opens with an overview.

---

## Phase 4 — listing pages & single-page change watch

**Goal:** support sites without feeds and pages watched for changes.

> **Status: done** (2026-10-22). Full article text for feeds:
> - Feed sources have `fetchArticles` (default on, migration `0003_add_fetch_articles`).
>   A new item's page is fetched only when the feed text is a teaser (under 1,500 chars,
>   `domain/article.ts`) and never for baseline items; the article text replaces the teaser
>   only if it is longer, and the whole page becomes the item's raw content.
> - Extraction: `@mozilla/readability` on `linkedom`; unreadable pages (cookie walls,
>   index pages, malformed HTML) count as "no article" and the teaser is kept. Fetch
>   failures never fail a collection; `collectSource` reports `articlesFetched` /
>   `articleFailures`.
> - Politeness: 2 article fetches at a time, at most 30 per source per run; the collect
>   activity timeout went up to 10 minutes.
> - `POST /sources/preview` returns an `articleSample` (feed vs. article length and an
>   excerpt) for teaser feeds, to check extraction before adding a source.
> - Real data: Phoronix 129 → 1,376 chars, 9to5Linux 405 → 1,899, LinuxGizmos 390 → 3,993;
>   summaries went from "the teaser gives no details" to specifics (CVSS scores, latency
>   numbers). Tweag already ships full text and is never fetched.
>
> Listing pages and page watch:
> - **Listing** (`kind: "listing"`, needs `linkSelector` and/or `urlPattern`): links of the
>   index page, same site only (`domain/article.ts#isListingArticle`), deduplicated with the
>   longest link text as title. The first run baselines the links without fetching anything;
>   later, each new link's page is fetched and read. A link whose article fails (or is over
>   the 30-per-run cap) is **not stored**, so the next run retries it. Verified on the Tweag
>   blog index (327 posts on one page, `urlPattern: "/blog/\\d{4}-\\d{2}-\\d{2}-"`).
> - **Page watch** (`kind: "page"`, optional `contentSelector`): the text is normalised
>   (whitespace, blank lines) and hashed; the first version (or the first after a URL change)
>   is the baseline in `sources.page_snapshot` (migration `0004_create_page_snapshot`, which
>   also allows item kind `change`). Each new version is one `change` item whose text lists
>   added/removed lines (own multiset line diff in `domain/page-watch.ts`, capped at 60 lines
>   each). Change items all live at the page URL, so their URL gets a `#change-<hash>` fragment
>   to stay unique. Verified end to end on a copy of kernel.org's `#releases` table.
> - Deviations from the plan: linkedom instead of cheerio (already a dependency), an own line
>   diff instead of the `diff` package, and the article-fetch limits (2 at a time, 30 per run)
>   instead of a per-host delay.
> - `htmlToText` now treats source line breaks as whitespace and separates table cells, so
>   table rows come out as one line each (changes then show the whole row).
> - Digests: `ExportedItem.kind` is `'article' | 'change'`; for changes the analysis prompt
>   asks what changed and why it matters. There is no separate "changes" section on the page:
>   a change is ranked like any other story (title "<page>: page changed").
> - Preview returns `entries` + `articleSample` for listings and a `pageSample` for pages.
>
> Follow-ups found by running all four sources from scratch (2026-10-22):
> - **First collection keeps the last 24 hours** (`FIRST_COLLECTION_WINDOW_MS`): a source
>   added today appears in today's digest; older and undated entries are the baseline. Before,
>   a new source showed nothing until it next posted. The from-scratch run produced 17 items
>   from all four sources (Phoronix 10, 9to5Linux 5, LinuxGizmos 1, Tweag 1).
> - **Batch keys hash their input** (`application/batch-key.ts`): a failed digest that is
>   restarted and collects *different* items used to get the old batch's results back (same
>   key) and lose the new items. Keys are now `digest-<id>-<step>-<hash of request>`: the same
>   input reuses the batch it paid for, different input gets a new one.
>
> End-to-end test with 20 sources (16 feeds, 2 listings, 2 watched pages; 2026-10-22):
> 80 items, 75 s in direct mode, about $0.02. One source (Fedora Magazine) answered 503 and
> was reported as failed while the run carried on.
> - **Cluster threshold raised to 0.75.** With full article text (phase 4), same-story pairs
>   across sources scored 0.80–0.94 and related-but-different stories at most 0.72 (SteamVR
>   vs. Steam client, a Ryzen review vs. a Ryzen relaunch story, daily security-update lists).
>   0.63 had been tuned on teasers and produced 3 false merges out of 9; anything from 0.72
>   to 0.78 gave the same 6 correct stories (KeePassXC across 4 sources, the Steam client
>   update across 3, `__get_user()` removal on LWN + Phoronix, PipeWire, Agama, DietPi).
> - Watched pages may be plain text (e.g. Mesa's `VERSION` file): the page extractor no longer
>   crashes on documents without an `<html>` element, and listings of such documents have
>   no links.
> - Note: token usage on a re-run includes reused results (what the results cost), not only
>   what that run newly spent.

- **Domain:**
  - `PageSnapshot` aggregate; `detectChange(previous, current)` ignores whitespace-only
    changes, and the first snapshot is the baseline.
  - `Item.kind: 'article' | 'change'` with an optional `diff`.
  - A cap on new articles per source per run.
- **Application:**
  - ports `ListingLinkExtractor`, `ArticleExtractor`, `PageTextExtractor`, `TextDiffer`
  - `collect-source` dispatches by `kind`
  - optional `fetchFullContent` for feeds whose entries are only teasers
- **Infrastructure:**
  - `extract/cheerio-listing-extractor.ts`: `linkSelector` and/or `urlPattern`, same-origin
    by default
  - `extract/readability-article-extractor.ts` (`@mozilla/readability` + `linkedom`)
  - `extract/page-text-extractor.ts` (optional `contentSelector`)
  - `diff/text-differ.ts` (`diff` package)
  - fixture HTML in `test/fixtures/pages/`
  - migration `0003_create_page_snapshot.ts`
- **Politeness:** per-host delay between article fetches (`FETCH_PER_HOST_DELAY_MS`) and
  `MAX_NEW_ITEMS_PER_SOURCE` (20).
- **Preview:** `POST /sources/preview` returns discovered links and extracted text for the
  new kinds, which is the selector-tuning tool.
- **Digests side:** `ExportedItem.kind`/`diff` is already in the contract. The analyzer
  prompt gets a "summarize what changed" variant for `change` items, and the renderer shows
  changes in their own section.
- **Done when:** a blog index without RSS yields articles with clean text, and an edited
  watched page produces one `change` item with a diff summary in the digest.

---

## Phase 5 — JS-rendered sites

**Goal:** fetch pages that need a browser, without making the normal worker depend on
Chromium.

- **Shared:**
  - `ModuleDefinition.worker` may return `WorkerDefinition | WorkerDefinition[]`;
    `worker-runtime.ts` flattens the result.
  - Config `BROWSER_FETCH_ENABLED` (false), `PLAYWRIGHT_CHROMIUM_PATH`.
- **Infrastructure:** `fetch/playwright-page-fetcher.ts` (`playwright-core`)
  - one browser per worker process, closed on shutdown through `Lifecycle`; a fresh context
    per fetch
  - `waitFor: 'networkidle' | selector` from the source config
  - hard timeout
  - int test against the fixture server serving a JS-only page
- **Sources module:** when browser fetching is enabled, a second worker definition on
  `sources-browser` with only the fetch activity. In `collectSourcesWorkflow`, a second
  `proxyActivities` with `taskQueue: 'sources-browser'` is used for `fetchMode: 'browser'`.
- **Dev env:** Playwright Chromium in `flake.nix`; a `worker-browser` process in
  `process-compose.yaml` (or the env flag on the existing worker).
- **Done when:** a JS-only fixture page and one real SPA are collected through the browser
  queue, and the normal worker still starts without Chromium installed.

---

## Phase 6 — hardening

Independent tasks, any order:

- **Batch failures:** failed lines from the error file → one retry batch; an `expired` batch →
  resubmit once; then items are marked skipped and counted in the footer.
- **Cross-day dedupe:** compare today's cluster embeddings with the last N days of published
  clusters, then drop the story or label it "update". Move to pgvector if the volume needs it.
- **Source health:** auto-disable after `SOURCE_MAX_CONSECUTIVE_FAILURES`. Shown in
  `GET /sources` and in the digest footer.
- **Notifications:** on publish or failure, `executeChild<SendNotificationWorkflow>` with
  idempotency key `digest-published:<runId>`. Recipient from config.
- **Cost:** token usage from batch output → stored per digest → shown in the footer and
  `GET /digests/:id`.
- **Retention:** document an S3 lifecycle rule for `sources/raw/` and `sources/exports/`,
  configured outside the app.
- **Optional:** `robots.txt` support; ETag-aware publishing (skip the upload when the HTML
  hash is unchanged).

---

## Phase 7 — multi-user (later)

- `sources`: sources become shared and deduplicated by URL; a new `Subscription(ownerId,
  sourceId)` replaces `Source.ownerId`. Migration backfills subscriptions from existing
  owners.
- `digests`: one profile and one digest per owner; per-owner publish key; the daily workflow
  fans out per owner after a single shared collection.
- Auth on the HTTP API, a prerequisite for the admin panel; the design is out of scope here.

---

## Checklist for every phase

- Every new domain rule has a domain test; every adapter has an integration test.
- New settings go in `loadConfig()` with production defaults; dev values in `.env.development`.
- `README.md`: new endpoints and curl examples.
- `pnpm format && pnpm check && pnpm test:integration`.
- Traces: one request/run is visible end to end in Grafana/Tempo.

## Open questions before phase 1

- Keep or remove the example `documents` context? `notifications` stays for phase 6.
- Which OpenAI models to use per task; it's config-only, but it affects cost estimates.
- Notification recipient (phase 6).
