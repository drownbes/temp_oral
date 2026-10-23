# temp-oral

TypeScript service scaffold: hexagonal architecture with DDD bounded contexts, PostgreSQL
(Kysely), S3, Temporal, structured logging (pino → VictoriaLogs) and distributed tracing
(OpenTelemetry → Tempo).

## Quick start

```sh
nix develop          # or `direnv allow` (.envrc: use flake)
pnpm install
pnpm dev             # process-compose: infra + migrations + api + worker
```

| What              | Where                                   |
| ----------------- | --------------------------------------- |
| HTTP API          | http://127.0.0.1:8080                   |
| Grafana           | http://127.0.0.1:3000 (anonymous admin) |
| Temporal UI       | http://127.0.0.1:8233                   |
| VictoriaLogs UI   | http://127.0.0.1:9428/select/vmui       |
| Postgres          | `postgres://postgres@127.0.0.1:5432/app` |
| S3 (versitygw)    | http://127.0.0.1:7070, bucket `app-dev`, key `devaccess` / `devsecretkey` |

All local state lives in `.data/` — delete it to start over.

```sh
curl -F uploadedBy=ada@example.com -F file=@README.md localhost:8080/documents
curl localhost:8080/documents/<id>                       # status: processed, checksum
curl 'localhost:8080/notifications?recipient=ada@example.com'
```

Sources and collection runs:

```sh
curl -XPOST localhost:8080/sources/preview -H 'content-type: application/json' \
  -d '{"url":"https://hnrss.org/frontpage"}'                    # dry run: what would be read
curl -XPOST localhost:8080/sources -H 'content-type: application/json' \
  -d '{"name":"HN","url":"https://hnrss.org/frontpage"}'        # kind defaults to "feed"
curl -XPOST localhost:8080/sources/collect -H 'content-type: application/json' \
  -d '{"runId":"2026-10-21"}'                                   # starts collectSourcesWorkflow
curl 'localhost:8080/sources/<id>/items?limit=20'
cat .data/s3/app-dev/sources/exports/2026-10-21.jsonl            # the run's export
```

A new source is tried the way the collector will read it (the same fetch and extraction as
the preview) before it is saved, and so is an existing one whose URL, kind, selectors or fetch
mode change. A source that cannot work is refused with `422 SOURCE_UNUSABLE`: the site refuses
it (e.g. 403 from bot protection), it is not a feed, or there is nothing to collect (no
entries, no matching links, no text; for HTTP sources the message suggests
`"fetchMode":"browser"`). A failure that may be temporary (5xx, timeout, no browser worker) or
an unreadable first article only adds to the `warnings` in the response. `"skipCheck": true`
saves without trying, e.g. for a feed that is empty for now.

Besides feeds, a source can be a **listing page** (a blog index without a feed:
`"kind":"listing"` with a `linkSelector` such as `"article h2"` and/or a `urlPattern`) or a
**watched page** (`"kind":"page"`, optionally narrowed with a `contentSelector`): each change
to its text becomes one digest item listing what was added and removed. Use the preview to tune
selectors:

```sh
curl -XPOST localhost:8080/sources/preview -H 'content-type: application/json' \
  -d '{"url":"https://www.kernel.org/","kind":"page","contentSelector":"#releases"}'
```

Feeds that only carry teasers get each new article's own page fetched and its text extracted
(Readability); set `"fetchArticles": false` on a source to keep the feed text. The preview
shows an `articleSample` so you can check the extraction first.

Sites that only render their content with JavaScript (an empty shell over plain HTTP) take
`"fetchMode":"browser"`: the page, and for listings each article page, is rendered in headless
Chromium. By default the page is read once the network goes quiet; `waitForSelector` waits for
a specific element instead. The preview works the same way (it runs on the browser worker):

```sh
curl -XPOST localhost:8080/sources/preview -H 'content-type: application/json' \
  -d '{"url":"https://store.steampowered.com/news/app/1675200","kind":"listing",
       "fetchMode":"browser","urlPattern":"/news/app/1675200/view/\\d+"}'
```

Content inside shadow DOM (Lit / web-component apps) is not part of the rendered HTML, so such
sites come out empty even in the browser.

A source's first collection is mostly a **baseline**: entries from the last 24 hours reach
the digest, older (or undated) ones are only remembered, so adding a site doesn't flood the
digest with its archive. Each item is exported by exactly one run; re-running a run id
rewrites the same export.

Digests (the `daily-digest` Temporal Schedule runs this every day at `DIGEST_CRON`):

```sh
curl -XPUT localhost:8080/profile -H 'content-type: application/json' \
  -d '{"interests":"Linux kernel, GPU drivers","relevanceThreshold":0.5}'
curl -XPOST localhost:8080/digests/runs -H 'content-type: application/json' -d '{}'   # today
curl localhost:8080/digests                                       # status, counts, token usage
curl localhost:8080/digests/<id>                                  # + every entry and its analysis
xdg-open .data/s3/app-dev/digests/latest/index.html              # the published page
```

Locally `LLM_PROVIDER=stub` fills in fake summaries instantly. With `LLM_PROVIDER=openai` and
`OPENAI_API_KEY` (put them in `.env`) items go through the OpenAI Batch API: half the price,
but results can take up to 24 hours, and the workflow waits on durable timers until they do.

In Grafana → Explore → Tempo, one trace spans `POST /documents` → S3 → Postgres →
`processDocumentWorkflow` → activities → `sendNotificationWorkflow`; "Logs for this span"
jumps to the matching VictoriaLogs lines, and log lines link back to the trace.

## Scripts

| Script                  | Does                                                               |
| ----------------------- | ------------------------------------------------------------------ |
| `pnpm dev`              | whole local stack (`process-compose up`)                           |
| `pnpm dev:api` / `dev:worker` | one process with reload (needs infra running)                |
| `pnpm db:migrate`       | apply every module's migrations                                    |
| `pnpm test`             | unit + workflow tests (self-contained, ephemeral Temporal server)  |
| `pnpm test:integration` | adapter tests against the running local stack (`app_test` DB)      |
| `pnpm typecheck` / `lint` / `format` / `arch` | tsc, Biome, dependency-cruiser rules         |
| `pnpm check`            | typecheck + lint + arch + unit tests                               |

Node runs `.ts` directly (type stripping); there is no build step. `tsc` only type checks, so
code must stick to erasable syntax (no enums, namespaces or parameter properties).

## Layout

```
src/
  main/                       composition roots: api.ts, worker.ts, migrate.ts, modules.ts
  shared/
    kernel/                   pure building blocks: DomainError, Brand, Clock
    infrastructure/           technical plumbing shared by all contexts:
                              config (zod), logger, telemetry, db pool + migrator,
                              S3 client, Temporal client/plugin/logger, HTTP server
  modules/<context>/
    domain/                   aggregates, value objects, domain errors, repository ports
    application/              use cases + outbound ports (and in-memory fakes for tests)
    infrastructure/           adapters implementing ports: Kysely repos, S3, Temporal starter
    interface/                adapters driving use cases: http routes, temporal workflows/activities
    contracts/                (optional) the context's published language for other contexts
    index.ts                  the module definition: wires ports to adapters
```

Contexts:

- **documents** (example) — upload to S3, metadata in Postgres, a Temporal workflow computes a
  checksum.
- **notifications** — idempotent notification sending; exposes a contract (task queue,
  workflow name, input/output types) that documents uses to start its workflow as a child.
- **sources** — the websites the digest tracks (feeds, listing pages, watched pages; over HTTP
  or rendered in a browser). A daily
  collection run fetches them, stores raw HTML + text under `sources/raw/`, and exports the
  run's new items to `sources/exports/<runId>.jsonl` (see `sources/contracts`). Design and
  roadmap: [`docs/website-digest-plan.md`](docs/website-digest-plan.md).
- **digests** — one digest per day: starts a sources collection run (child workflow through
  the sources contract), has every new item summarised, scored against the reader's interest
  profile and embedded (two LLM batches), groups coverage of the same story from different
  sources, merges each such story into one headline and writes an overview (a third batch),
  ranks the stories, and publishes a single static HTML page to `DIGEST_PUBLISH_KEY` in S3.

### Rules (enforced by `pnpm arch`)

- `domain` imports only its own domain and `shared/kernel` — no npm packages, no node builtins.
- `application` imports only its own domain/application and `shared/kernel`.
- Contexts import each other only via `modules/<other>/contracts`.
- `shared` never imports `modules`; `src/main` uses only `modules/*/index.ts`.
- `workflows.ts` (Temporal sandbox) imports only `@temporalio/workflow`, contracts and types.

### Shared vs. owned infrastructure

Shared (one per process): Postgres pool, S3 client, Temporal connection, logger, telemetry,
config. Owned by each context: its Postgres **schema** (and migration history, tracked in
that schema), its S3 **key prefix**, its Temporal **task queue**, its repositories and adapters.
That keeps the option of splitting a context into its own service open.

### Adding a context

1. Create `src/modules/<name>/` with the layers above and an `index.ts` exporting a
   `ModuleDefinition` (`migrations`, optional `http`, optional `worker`).
2. Put migrations in `infrastructure/persistence/migrations/` against schema `<name>`.
3. Register it in `src/main/modules.ts`.

## Observability

- **Logs**: pino JSON on stdout with `service`, `component`, `level`, ISO `time`, `msg`, and
  `trace_id`/`span_id` whenever a span is active (HTTP requests, activities, workflow logs via
  Temporal sinks). Production log agents ship stdout to VictoriaLogs; locally
  `scripts/dev/ship-logs.ts` does it and pretty-prints to the terminal.
- **Traces**: OpenTelemetry SDK, configured with the standard `OTEL_*` env vars
  (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_TRACES_SAMPLER`, `OTEL_RESOURCE_ATTRIBUTES`,
  `OTEL_SERVICE_NAME`, `OTEL_SDK_DISABLED`). Instrumented: http, undici/fetch, Fastify,
  pg, AWS SDK, Temporal client/workflows/activities. Service names default to
  `temp-oral-api` and `temp-oral-worker`.

## Configuration

Validated once at startup by `src/shared/infrastructure/config.ts`; invalid config exits with a
readable report. Local values are in `.env.development` (checked in); put overrides in `.env`
(git-ignored). Production gets real environment variables; AWS credentials come from the default
provider chain. Set `TEMPORAL_API_KEY` for Temporal Cloud (enables TLS).

Scraping uses `FETCH_TIMEOUT_MS`, `FETCH_MAX_BYTES` and `FETCH_USER_AGENT`. Fetches to private,
loopback and link-local addresses are refused (SSRF protection, checked on every redirect and
at connect time); `.env.development` sets `FETCH_ALLOW_PRIVATE_NETWORKS=true` so local test
servers work. Never enable it in production.

Browser sources run on their own task queue, `sources-browser`, served only by workers with
`BROWSER_FETCH_ENABLED=true`; only those need Chromium (`BROWSER_EXECUTABLE_PATH`, or
Playwright's own via `PLAYWRIGHT_BROWSERS_PATH`, which the Nix shell sets). `BROWSER_CONCURRENCY`
(2) sources are rendered at a time, each page within `BROWSER_TIMEOUT_MS` (30000). Every
request a page makes goes through the same address guard as plain fetches. Locally one worker
serves every queue; in production run the browser worker as its own deployment:

```sh
# main worker: no Chromium needed
BROWSER_FETCH_ENABLED=false                                     # the default
# browser worker
BROWSER_FETCH_ENABLED=true WORKER_TASK_QUEUES=sources-browser
```

`WORKER_TASK_QUEUES` (comma-separated) limits a worker to some queues; unset, it serves all.
Without a browser worker, browser sources are reported as failed after 15 minutes and the run
carries on; a browser preview answers 422 after 20 seconds.

Digests: `LLM_PROVIDER` (`openai` | `stub`), `OPENAI_API_KEY`, `OPENAI_API_MODE` (`batch`, the
default: Batch API, half price, up to 24h | `direct`: normal API, full price, seconds; use it
for testing), `OPENAI_ITEM_MODEL` (default
`gpt-6-luna`), `OPENAI_REASONING_EFFORT` (default `low`; `omit` for non-reasoning models), `DIGEST_CRON` + `DIGEST_TIMEZONE` (when the daily run fires, and which calendar
day it covers), `DIGEST_PUBLISH_BUCKET` / `DIGEST_PUBLISH_KEY` (where the page goes; bucket
defaults to `S3_BUCKET`), `DIGEST_MAX_ITEM_CHARS` (article text sent to the LLM per item).
Grouping: `OPENAI_EMBEDDING_MODEL` (default `text-embedding-3-small`),
`OPENAI_EMBEDDING_DIMENSIONS` (512), `DIGEST_CLUSTER_THRESHOLD` (0.75: cosine similarity at
which items from different sources count as the same story; a story never holds two items
of one source). Merged headlines and the overview use `OPENAI_SYNTHESIS_MODEL` (default
`gpt-6-luna`).

Stories the reader has already seen are recognised by comparing them with the digests
published in the last `DIGEST_HISTORY_DAYS` (7) days. A story whose every item is a near-copy
of an earlier one (`DIGEST_REPEAT_THRESHOLD`, 0.97: reposts and syndicated copies) is left out
of the page and only listed in the footer; one that is merely close
(`DIGEST_FOLLOW_UP_THRESHOLD`, 0.85) stays and is labelled as a follow-up, linking the earlier
report. `GET /digests/:id` shows each story's `earlier` match and its similarity, for tuning.

## Things worth knowing

- **MinIO is gone from nixpkgs**; local S3 is [versitygw](https://github.com/versity/versitygw)
  serving `.data/s3/<bucket>` directories.
- **`node --watch` breaks Temporal workers** (watch mode posts messages from worker threads,
  which Temporal's workflow thread pool misreads), so `dev:worker` uses `watchexec`.
- **Temporal's OTel interceptors are still on OTel SDK 1.x.** Workflow spans are converted
  to the 2.x shape in `shared/infrastructure/temporal/temporal.ts` (`WorkflowSpanAdapter`);
  remove it once Temporal upgrades.
- **TypeScript 7** has no JS compiler API yet, so dependency-cruiser parses with swc and prints a
  `missing-typescript-transpiler` warning. The rules are still checked.
- Tempo 3.x in single-binary mode logs harmless `backendworker ... no jobs found` errors.
