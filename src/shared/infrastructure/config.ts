import { z } from 'zod';

const LogLevel = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);

const ModelPrices = z.record(
  z.string(),
  z.object({ input: z.number().min(0), output: z.number().min(0) }),
);

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
    SERVICE_NAME: z.string().min(1).default('temp-oral'),
    LOG_LEVEL: LogLevel.default('info'),

    HTTP_HOST: z.string().default('0.0.0.0'),
    HTTP_PORT: z.coerce.number().int().positive().default(8080),
    HTTP_MAX_UPLOAD_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(10 * 1024 * 1024),

    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

    // Credentials come from the default AWS provider chain (env, IRSA, instance profile, ...)
    S3_BUCKET: z.string().min(1),
    S3_ENDPOINT: z.url().optional(),
    S3_FORCE_PATH_STYLE: z.stringbool().default(false),
    AWS_REGION: z.string().min(1).default('us-east-1'),

    TEMPORAL_ADDRESS: z.string().min(1),
    TEMPORAL_NAMESPACE: z.string().min(1).default('default'),
    // Set for Temporal Cloud; enables TLS
    TEMPORAL_API_KEY: z.string().min(1).optional(),

    // Outbound HTTP for scraping
    FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
    FETCH_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(5 * 1024 * 1024),
    FETCH_USER_AGENT: z.string().min(1).default('temp-oral-digest/0.1 (+feed reader)'),
    // Keep false in production: URLs come from the API, so private addresses would be SSRF
    FETCH_ALLOW_PRIVATE_NETWORKS: z.stringbool().default(false),
    // A source that failed this many collections in a row stops being collected (about that
    // many days with the daily schedule) until it is enabled again
    SOURCE_MAX_CONSECUTIVE_FAILURES: z.coerce.number().int().min(1).default(5),

    // Headless Chromium for JS-rendered sources. Only the worker serving the sources-browser
    // queue needs it; without it, browser sources fail and are reported as failed.
    BROWSER_FETCH_ENABLED: z.stringbool().default(false),
    // Chromium binary; when unset, Playwright's own (PLAYWRIGHT_BROWSERS_PATH or its cache)
    BROWSER_EXECUTABLE_PATH: z.string().min(1).optional(),
    // Sources rendered at the same time by one worker; each one is a browser context
    BROWSER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
    // Navigation plus waiting for the content, per page
    BROWSER_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

    // Comma-separated task queues this worker serves; all of them when unset
    WORKER_TASK_QUEUES: z.string().min(1).optional(),

    // LLM: `stub` answers instantly with fake output, for local development without cost
    LLM_PROVIDER: z.enum(['openai', 'stub']).default('openai'),
    OPENAI_API_KEY: z.string().min(1).optional(),
    // batch: Batch API, half price, results within 24h (production). direct: normal API, full
    // price, results in seconds (testing). Batches already submitted finish either way.
    OPENAI_API_MODE: z.enum(['batch', 'direct']).default('batch'),
    OPENAI_DIRECT_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
    OPENAI_ITEM_MODEL: z.string().min(1).default('gpt-6-luna'),
    // Reasoning models think before answering, billed as output tokens; summaries need little.
    // `omit` leaves the parameter out, for models that don't support it.
    OPENAI_REASONING_EFFORT: z.enum(['omit', 'none', 'low', 'medium', 'high']).default('low'),
    // One request per multi-source story plus the overview: few calls, so a stronger model is cheap
    OPENAI_SYNTHESIS_MODEL: z.string().min(1).default('gpt-6-luna'),
    OPENAI_EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-small'),
    OPENAI_EMBEDDING_DIMENSIONS: z.coerce.number().int().min(64).max(3072).default(512),
    // USD per million tokens on the normal API (the Batch API charges half), added to and
    // overriding the built-in prices, e.g. {"gpt-6-luna":{"input":0.1,"output":0.5}}.
    // Models without a price show an unknown cost.
    OPENAI_PRICES: z
      .string()
      .default('{}')
      .transform((value, ctx) => {
        try {
          return ModelPrices.parse(JSON.parse(value));
        } catch {
          ctx.addIssue({
            code: 'custom',
            message: 'must be JSON: {"<model>":{"input":n,"output":n}}',
          });
          return z.NEVER;
        }
      }),

    // Daily digest
    DIGEST_CRON: z.string().min(1).default('0 6 * * *'),
    DIGEST_TIMEZONE: z.string().min(1).default('UTC'),
    // Defaults to S3_BUCKET; set it to publish the page to a separate (e.g. public) bucket
    DIGEST_PUBLISH_BUCKET: z.string().min(1).optional(),
    DIGEST_PUBLISH_KEY: z.string().min(1).default('digests/latest/index.html'),
    // Told when a digest is published or fails (through the notifications context); no
    // notifications when unset. DIGEST_PUBLIC_URL, if the page is served, goes in the message.
    DIGEST_NOTIFY_RECIPIENT: z.email().optional(),
    DIGEST_PUBLIC_URL: z.url().optional(),
    // Article text sent to the LLM per item; longer texts are cut
    DIGEST_MAX_ITEM_CHARS: z.coerce.number().int().positive().default(16_000),
    // Cosine similarity at which two items count as the same story (embedding-model specific)
    DIGEST_CLUSTER_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),
    // Stories already shown by the digests of the last DIGEST_HISTORY_DAYS days: near-copies
    // (>= DIGEST_REPEAT_THRESHOLD) are left out, similar ones (>= DIGEST_FOLLOW_UP_THRESHOLD)
    // are labelled as follow-ups. Same-day grouping is looser: across days, related stories
    // (daily series, two changes to one subsystem) embed closer than within a day.
    DIGEST_HISTORY_DAYS: z.coerce.number().int().min(0).max(60).default(7),
    DIGEST_REPEAT_THRESHOLD: z.coerce.number().min(0).max(1).default(0.97),
    DIGEST_FOLLOW_UP_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  })
  .superRefine((env, ctx) => {
    if (env.DIGEST_FOLLOW_UP_THRESHOLD > env.DIGEST_REPEAT_THRESHOLD) {
      ctx.addIssue({
        code: 'custom',
        path: ['DIGEST_FOLLOW_UP_THRESHOLD'],
        message: 'must not be above DIGEST_REPEAT_THRESHOLD',
      });
    }
    if (env.LLM_PROVIDER === 'openai' && !env.OPENAI_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPENAI_API_KEY'],
        message: 'required when LLM_PROVIDER=openai',
      });
    }
    try {
      new Intl.DateTimeFormat('en', { timeZone: env.DIGEST_TIMEZONE });
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['DIGEST_TIMEZONE'],
        message: 'unknown IANA time zone',
      });
    }
  });

export type AppConfig = ReturnType<typeof toConfig>;

function toConfig(env: z.infer<typeof EnvSchema>) {
  return {
    env: env.NODE_ENV,
    serviceName: env.SERVICE_NAME,
    log: { level: env.LOG_LEVEL },
    http: { host: env.HTTP_HOST, port: env.HTTP_PORT, maxUploadBytes: env.HTTP_MAX_UPLOAD_BYTES },
    database: { url: env.DATABASE_URL, poolMax: env.DATABASE_POOL_MAX },
    s3: {
      bucket: env.S3_BUCKET,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      region: env.AWS_REGION,
    },
    temporal: {
      address: env.TEMPORAL_ADDRESS,
      namespace: env.TEMPORAL_NAMESPACE,
      apiKey: env.TEMPORAL_API_KEY,
    },
    fetch: {
      timeoutMs: env.FETCH_TIMEOUT_MS,
      maxBytes: env.FETCH_MAX_BYTES,
      userAgent: env.FETCH_USER_AGENT,
      allowPrivateNetworks: env.FETCH_ALLOW_PRIVATE_NETWORKS,
    },
    sources: { maxConsecutiveFailures: env.SOURCE_MAX_CONSECUTIVE_FAILURES },
    browser: {
      enabled: env.BROWSER_FETCH_ENABLED,
      executablePath: env.BROWSER_EXECUTABLE_PATH,
      concurrency: env.BROWSER_CONCURRENCY,
      timeoutMs: env.BROWSER_TIMEOUT_MS,
    },
    worker: {
      taskQueues: env.WORKER_TASK_QUEUES
        ? new Set(
            env.WORKER_TASK_QUEUES.split(',')
              .map((queue) => queue.trim())
              .filter(Boolean),
          )
        : undefined,
    },
    llm: {
      provider: env.LLM_PROVIDER,
      openaiApiKey: env.OPENAI_API_KEY,
      apiMode: env.OPENAI_API_MODE,
      directConcurrency: env.OPENAI_DIRECT_CONCURRENCY,
      itemModel: env.OPENAI_ITEM_MODEL,
      reasoningEffort:
        env.OPENAI_REASONING_EFFORT === 'omit' ? undefined : env.OPENAI_REASONING_EFFORT,
      synthesisModel: env.OPENAI_SYNTHESIS_MODEL,
      embeddingModel: env.OPENAI_EMBEDDING_MODEL,
      embeddingDimensions: env.OPENAI_EMBEDDING_DIMENSIONS,
      prices: env.OPENAI_PRICES,
    },
    digest: {
      cron: env.DIGEST_CRON,
      timezone: env.DIGEST_TIMEZONE,
      publishBucket: env.DIGEST_PUBLISH_BUCKET ?? env.S3_BUCKET,
      publishKey: env.DIGEST_PUBLISH_KEY,
      notifyRecipient: env.DIGEST_NOTIFY_RECIPIENT,
      publicUrl: env.DIGEST_PUBLIC_URL,
      maxItemChars: env.DIGEST_MAX_ITEM_CHARS,
      clusterThreshold: env.DIGEST_CLUSTER_THRESHOLD,
      earlierCoverage: {
        days: env.DIGEST_HISTORY_DAYS,
        repeat: env.DIGEST_REPEAT_THRESHOLD,
        followUp: env.DIGEST_FOLLOW_UP_THRESHOLD,
      },
    },
  } as const;
}

/** Parses and validates the environment once at startup; exits with a readable report on failure. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    console.error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
    process.exit(1);
  }
  return toConfig(parsed.data);
}
