import { type AppConfig, loadConfig } from '#shared/infrastructure/config.ts';

/** Local stack from .env.development, but a separate `app_test` database. */
export function integrationConfig(): AppConfig {
  process.loadEnvFile('.env.development');
  const url = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '');
  if (!process.env.TEST_DATABASE_URL) url.pathname = '/app_test';
  return loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: url.href,
  });
}
