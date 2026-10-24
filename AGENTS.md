# AGENTS.md

Guidance for anyone (human or AI agent) changing this codebase. Read this before adding code.
`README.md` covers running the project; this file covers **how the code is organised and why**.

## Principles

1. **Hexagonal architecture (ports & adapters).** Business logic sits in the middle and knows
   nothing about HTTP, Postgres, S3 or Temporal. It declares **ports** (interfaces) for what it
   needs; **adapters** at the edge implement them. Dependencies always point inward.
2. **DDD bounded contexts.** Each business capability is a module in `src/modules/<context>/`
   with its own model, language, persistence and task queue. Contexts are independent and talk
   only through published **contracts**.
3. **Share technical plumbing, never business code.** Connection pools, clients, logger,
   telemetry and config are shared (`src/shared/infrastructure`). Anything that knows a table,
   bucket prefix or workflow name belongs to exactly one context.
4. **Rich aggregates, thin edges.** Invariants and state transitions live in domain methods.
   HTTP routes, activities and repositories only translate data and call use cases.
5. **Explicit wiring.** No DI container, no decorators, no module-level singletons in business
   code. Dependencies go in through constructors and are wired in each module's `index.ts`.
6. **Everything that may be retried is idempotent.** Activities, use cases called from them and
   workflow starts must be safe to run twice (deterministic IDs, idempotency keys, status checks).
7. **Observable by default.** Structured JSON logs with trace correlation, OpenTelemetry spans
   across HTTP → DB/S3 → Temporal, OTLP metrics (incl. Temporal's). Don't add `console.log`;
   use the injected pino logger. A span marked failed should mean a real failure: an expected
   miss (cache lookup, optional object) must not surface as an erroring call.
8. **Boundaries are enforced, not just documented.** `pnpm arch` (dependency-cruiser) fails the
   build on layer and context violations. Fix the design; don't weaken the rules.

## Code organisation

```
src/
  main/                         composition roots (process entrypoints)
    api.ts, worker.ts           start telemetry FIRST, then dynamically import the rest
    api-server.ts, worker-runtime.ts, migrate.ts
    deps.ts                     creates shared infrastructure (db, s3, temporal) once per process
    modules.ts                  list of all bounded contexts in this deployable
  shared/
    kernel/                     Shared Kernel: pure, framework-free building blocks
                                (DomainError hierarchy, Brand<T>, Clock). Keep it tiny.
    infrastructure/             shared technical plumbing: config (zod), logger, telemetry,
                                db pool + migrator, S3 client, Temporal client/plugin/logger,
                                HTTP server + error mapping, ModuleDefinition contract
  modules/<context>/
    domain/                     aggregates, value objects, domain errors, repository ports
    application/                use cases (one class per use case) + outbound ports
      testing/                  in-memory fakes of the ports, for tests only
    infrastructure/             outbound adapters implementing ports
      persistence/              Kysely repository, tables.ts, migrations/
      storage/, temporal/, ...  other adapters (S3, workflow starter, senders)
    interface/                  inbound adapters that drive use cases
      http/routes.ts            Fastify plugin
      temporal/                 workflows.ts, activities.ts, definitions.ts
    contracts/                  (optional) published language for OTHER contexts
    index.ts                    module definition: wires ports to adapters; the only file
                                src/main may import
```

### Dependency rules (enforced by `pnpm arch`)

| From | May import |
|---|---|
| `modules/X/domain` | `modules/X/domain`, `shared/kernel`. **No npm packages, no node builtins.** |
| `modules/X/application` | `modules/X/{domain,application}`, `shared/kernel` |
| `modules/X/infrastructure`, `modules/X/interface` | anything in `modules/X`, `shared/*`, npm packages |
| `modules/X/**` | other contexts **only** via `modules/Y/contracts` |
| `modules/X/contracts` | other contracts only (plain constants and types) |
| `modules/X/interface/temporal/workflows.ts` | `@temporalio/workflow`, contracts, own `definitions.ts`; anything else **type-only** |
| `shared/kernel` | nothing outside itself |
| `shared/**` | never `modules/**` or `main/**` |
| `main/**` | `shared/*`, `modules/*/index.ts` only |

No circular dependencies anywhere.

### What each context owns

- A **Postgres schema** named after the context (`documents`, `notifications`), its tables, and
  its migration history (tracked inside that schema). Never query another context's schema.
- An **S3 key prefix** (`documents/…`) in the shared bucket.
- A **Temporal task queue** (`documents`, `notifications`). Cross-context work is started by
  workflow name on the other context's queue, using names/types from its `contracts/`.

## Layer conventions

### Domain
- Aggregate = class with private state (`#state`), a `static` factory that validates invariants
  (`Document.upload`), `static restore(snapshot)` for rehydration without validation,
  intention-revealing methods for transitions, and `toSnapshot()` returning a readonly plain object.
- IDs are branded strings (`Brand<string, 'DocumentId'>`) with a `newXxxId()` helper.
- Errors extend `NotFoundError` / `ValidationError` / `ConflictError` from `shared/kernel` and
  have a stable `code`. Adapters map by class/code, never by message.
- Time is passed in (`now: Date`); the domain never calls `new Date()`.

### Application
- One class per use case with a `#deps` field, a `XxxDeps` interface, and `execute(input)`.
- Depends on ports (domain repositories, `application/ports.ts`) and `Clock`, never adapters.
- Returns snapshots/plain results, not aggregates, to the edge.
- Use cases invoked by activities must be idempotent (see `ProcessDocument`, `SendNotification`).

### Infrastructure (outbound adapters)
- Class `implements` the port; takes its client in the constructor.
- Kysely: tables are `type` aliases keyed by `'<schema>.<table>'` in `tables.ts`; the repository
  receives `db.withTables<ContextTables>()`. Map rows ↔ domain explicitly (`toDomain`/`toRow`).
- Migrations: `infrastructure/persistence/migrations/NNNN_description.ts` exporting `up`/`down`,
  always `db.schema.withSchema('<context>')`. Never edit an applied migration; add a new one.

### Interface (inbound adapters)
- HTTP: a named Fastify plugin function (`async function documentsHttp(app)` — the name shows
  up in spans). Validate input with zod (`ZodError` → 400), call a use case, map to a DTO.
  Throw domain errors; the shared error handler maps them (404/422/409).
- Activities: thin wrappers around use cases, wrapped in `failOnDomainError` so domain errors
  become non-retryable. Export `type XxxActivities = ReturnType<typeof createXxxActivities>`.
- Workflows: orchestration only, deterministic, no I/O. Use `proxyActivities<XxxActivities>`
  (type-only import), `log` from `@temporalio/workflow`, and contracts for cross-context calls.
  The exported function name **is** the workflow type; keep it equal to the constant in
  `definitions.ts` / `contracts/`.

### Module `index.ts`
- Exports one `ModuleDefinition`: `name`, `migrations`, optional `http(deps)`, optional
  `worker(deps)`. Build adapters from `ModuleDeps`, inject them into use cases, return routes /
  worker definition. Only `http` creates things the API needs; only `worker` creates activities.

## Recipes

**Add a use case:** domain method(s) + test → use case in `application/` + test with fakes →
route and/or activity in `interface/` → wire in `index.ts`.

**Add a port/adapter:** interface in `application/ports.ts` (or `domain/` for repositories) →
fake in `application/testing/fakes.ts` → adapter in `infrastructure/` + `*.int.test.ts` →
wire in `index.ts`.

**Call another context:** add/extend the target's `contracts/index.ts` (task queue, workflow
name, input/output types, `XxxWorkflow` function type) → implement it in the target's
`workflows.ts` as `export const xxxWorkflow: XxxWorkflow = …` → from the caller's workflow use
`executeChild<XxxWorkflow>(NAME, { taskQueue, workflowId, args })` with a deterministic
`workflowId` and an idempotency key.

**Add a bounded context:** create `src/modules/<name>/` with the layers above and an
`index.ts` → migrations against schema `<name>` → register in `src/main/modules.ts` →
new task queue if it has workflows.

**Shared code:** pure and model-level → `shared/kernel` (rarely; it couples every context).
Technical and context-agnostic → `shared/infrastructure`. Knows anything business-specific →
it belongs in a context.

## Tests

| Kind | Location / name | Runs with |
|---|---|---|
| Domain | `domain/*.test.ts` | `pnpm test` |
| Use case (in-memory fakes) | `application/*.test.ts` | `pnpm test` |
| Workflow (ephemeral Temporal server, fake activities) | `interface/temporal/*.test.ts` | `pnpm test` |
| Adapter (real Postgres/S3, `app_test` DB) | `infrastructure/**/*.int.test.ts` | `pnpm test:integration` (needs `pnpm dev`) |

Every new domain rule gets a domain test; every adapter gets an integration test.

## Language & tooling constraints

- Node 26 runs `.ts` directly (type stripping); `tsc` (TypeScript 7) only type checks. Use
  **erasable syntax only**: no `enum`, `namespace`, parameter properties or decorators. Use
  `as const` objects / union types instead of enums.
- Relative imports include the `.ts` extension. Cross-tree imports use subpath aliases
  `#shared/*`, `#modules/*`, `#test/*` (package.json `imports`).
- `import type` for type-only imports (Biome enforces it).
- Config only via `loadConfig()` (zod-validated env); add new settings to its schema with
  defaults suitable for production, and dev values to `.env.development`.
- Logging: inject `Logger`; log structured objects first, message second
  (`logger.info({ documentId }, 'document processed')`). Never log secrets or file contents.
- Telemetry must start before instrumented libraries are imported — entrypoints in `src/main`
  import the rest dynamically after `startTelemetry()`. Keep it that way.

## Before you finish

```sh
pnpm check              # typecheck + lint + architecture rules + unit/workflow tests
pnpm test:integration   # if you touched adapters/migrations (requires `pnpm dev`)
```

Run `pnpm format` to apply Biome fixes. Don't silence `pnpm arch` violations by editing
`.dependency-cruiser.cjs` — restructure the code instead, or discuss changing the rule.
