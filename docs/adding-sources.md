# Adding sources

"Adding a source" means one of two things:

1. **Tracking a new site** with one of the existing kinds: no code, just the API.
2. **Adding a new source kind** (e.g. Reddit, Mastodon, podcasts): a feature in the `sources`
   context.

Paths are relative to `src/modules/sources/` unless they start with `src/` or `test/`.

## 1. Tracking a new site (no code)

If the site fits one of the kinds `feed`, `listing`, `page` or `youtube`, add it through the
API (with `pnpm dev` running):

```sh
# Dry run: what the collector would read
curl -XPOST localhost:8080/sources/preview -H 'content-type: application/json' \
  -d '{"url":"https://example.com/blog","kind":"listing","linkSelector":"article h2 a"}'

# Save it: it is tried the same way first and refused with 422 SOURCE_UNUSABLE if it can't work
curl -XPOST localhost:8080/sources -H 'content-type: application/json' \
  -d '{"name":"Example","url":"https://example.com/blog","kind":"listing","linkSelector":"article h2 a"}'
```

Choosing a kind:

| The site | Kind | Options |
|---|---|---|
| Has an RSS / Atom / JSON feed | `feed` (default) | `fetchArticles` (default `true`) |
| Is a blog index without a feed | `listing` | `linkSelector` and/or `urlPattern` |
| Is a single page whose changes matter | `page` | `contentSelector` (optional) |
| Is a YouTube channel | `youtube` | none; a `youtube.com/@handle` URL is fine |

Sites that only render with JavaScript also need `"fetchMode":"browser"` (not for `youtube`).
More examples are in the [README](../README.md).

## 2. Adding a new source kind (code)

The worked example is the commit that added YouTube channels (`git show 81037ca`): it touches
every layer in the order of the [`AGENTS.md`](../AGENTS.md) recipes. Read it alongside these
steps and work inside out.

### Step 1: Domain (`domain/`)

Rules only: no npm packages, no I/O.

- `source.ts`: add the kind to `SOURCE_KINDS`, a variant to the `SourceSettings` union with its
  options, and a `case` in `sourceSettings()` that validates them.
- URL rules for the kind go in `validTarget()` and `fetchUrlOf()` (YouTube turns a channel URL
  into its feed URL there).
- Pure helpers go in their own file, as `youtube.ts` holds `isYouTubeShort` and `videoText`.
- Add `case` branches to the other switches on the kind (e.g. `article.ts`).
- Tests: `source.test.ts` and `<kind>.test.ts`.

Once the union is widened, `pnpm typecheck` points at every `switch` on `settings.kind` that
no longer covers all kinds. Work until it is clean.

### Step 2: Application (`application/`)

- `ports.ts`: an interface for anything outside you need, in business terms (YouTube added
  `YouTubeChannels` and `VideoTranscripts`).
- `testing/fakes.ts`: an in-memory fake for each new port.
- `supported-sources.ts`: add the kind to `SUPPORTED_KINDS`.
- `collect-source.ts`: a `case` in `execute()` that turns the fetched page into entries and
  hands them to `#storeNew()`. That gives you dedupe, baselining, deterministic item ids and
  content storage. Only write your own path when the shape really differs, as `#watchPage`
  does for `page`.
- `preview-source.ts` / `check-source.ts`: what the preview shows, and when a source counts
  as unusable (the `nothingToCollect()` switch).
- `create-source.ts` / `update-source.ts`: only if the URL must be resolved before saving
  (YouTube looks a `@handle` up once and saves the channel URL).
- Use case tests with fakes, like `youtube-sources.test.ts`.

### Step 3: Infrastructure (`infrastructure/`)

- The adapter: a class that `implements` the port and takes its config or client in the
  constructor (e.g. `youtube/youtube-client.ts`).
- A new migration `persistence/migrations/NNNN_allow_<kind>_sources.ts` that drops and re-adds
  `source_kind_check`, as `0007_allow_youtube_sources.ts` does; options of the kind become
  columns, always with `withSchema('sources')`. Never edit an applied migration.
- `persistence/kysely-source-repository.ts`: a `case` in `toSettings()`, and the row mapping
  for any new columns.
- Tests: an `*.int.test.ts` for adapters that talk to Postgres/S3, unit tests with fixtures for
  parsing (YouTube used `test/fixtures/feeds/youtube.xml`).

### Step 4: Interface (`interface/`)

Usually nothing: the HTTP body schema already uses `z.enum(SOURCE_KINDS)`. New options of the
kind go into the zod schemas in `http/routes.ts`.

### Step 5: Wiring (`index.ts`)

Build the adapter in `adapters()` and pass it into the use cases that need it: in `http()`
create, update and preview; in `worker()` `CollectSource`, and the browser `PreviewSource`
if it applies. No container: it is passed in by hand.

### Step 6: Docs and checks

- A paragraph and a `curl` preview example in the [README](../README.md), and a row in the
  table above.
- `pnpm check` (types, lint, architecture rules, tests) and `pnpm test:integration` (you
  touched a migration and adapters).
- A real try: preview a real URL, save it, then `POST /sources/collect`.

### Rules that are easy to break

- **Idempotency.** Collection runs as a Temporal activity and may run twice. Reusing
  `itemIdFor()` and `#storeNew()` keeps it safe.
- **Be gentle with sites.** Limit concurrency with `mapConcurrent` and cap fetches per run
  (`MAX_ARTICLE_FETCHES`).
- **Errors.** Permanent failures throw `SourceFetchError` and are not retried; anything else
  is treated as transient and retried.
- **Time.** No `new Date()` in the domain; use the use case's `clock`.
- **Logging.** The injected logger, never `console.log`.
- **Boundaries.** If `pnpm arch` complains, change the structure, not `.dependency-cruiser.cjs`.
