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

A source's first collection is a **baseline**: its current entries are remembered but not
exported, so only articles published after you add a source reach the digest. Each item is
exported by exactly one run; re-running a run id rewrites the same export.

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
- **sources** — the websites the digest tracks (RSS/Atom/RDF/JSON feeds so far). A daily
  collection run fetches them, stores raw HTML + text under `sources/raw/`, and exports the
  run's new items to `sources/exports/<runId>.jsonl` (see `sources/contracts`). Design and
  roadmap: [`docs/website-digest-plan.md`](docs/website-digest-plan.md).
- **digests** — one digest per day: starts a sources collection run (child workflow through
  the sources contract), has every new item summarised and scored against the reader's
  interest profile by an LLM batch, ranks them, and publishes a single static HTML page to
  `DIGEST_PUBLISH_KEY` in S3.

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

Digests: `LLM_PROVIDER` (`openai` | `stub`), `OPENAI_API_KEY`, `OPENAI_ITEM_MODEL` (default
`gpt-6-luna`), `OPENAI_REASONING_EFFORT` (default `low`; `omit` for non-reasoning models), `DIGEST_CRON` + `DIGEST_TIMEZONE` (when the daily run fires, and which calendar
day it covers), `DIGEST_PUBLISH_BUCKET` / `DIGEST_PUBLISH_KEY` (where the page goes; bucket
defaults to `S3_BUCKET`), `DIGEST_MAX_ITEM_CHARS` (article text sent to the LLM per item).

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
