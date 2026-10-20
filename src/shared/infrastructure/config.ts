import { z } from 'zod';

const LogLevel = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);

const EnvSchema = z.object({
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
