import { z } from 'zod';

const LogLevel = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);

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

    // Daily digest
    DIGEST_CRON: z.string().min(1).default('0 6 * * *'),
    DIGEST_TIMEZONE: z.string().min(1).default('UTC'),
    // Defaults to S3_BUCKET; set it to publish the page to a separate (e.g. public) bucket
    DIGEST_PUBLISH_BUCKET: z.string().min(1).optional(),
    DIGEST_PUBLISH_KEY: z.string().min(1).default('digests/latest/index.html'),
    // Article text sent to the LLM per item; longer texts are cut
    DIGEST_MAX_ITEM_CHARS: z.coerce.number().int().positive().default(16_000),
    // Cosine similarity at which two items count as the same story (embedding-model specific)
    DIGEST_CLUSTER_THRESHOLD: z.coerce.number().min(0).max(1).default(0.63),
  })
  .superRefine((env, ctx) => {
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
    },
    digest: {
      cron: env.DIGEST_CRON,
      timezone: env.DIGEST_TIMEZONE,
      publishBucket: env.DIGEST_PUBLISH_BUCKET ?? env.S3_BUCKET,
      publishKey: env.DIGEST_PUBLISH_KEY,
      maxItemChars: env.DIGEST_MAX_ITEM_CHARS,
      clusterThreshold: env.DIGEST_CLUSTER_THRESHOLD,
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
