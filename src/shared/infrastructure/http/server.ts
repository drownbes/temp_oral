import multipart from '@fastify/multipart';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from 'fastify';
import { ZodError } from 'zod';
import { ConflictError, DomainError, NotFoundError, ValidationError } from '../../kernel/errors.ts';
import type { Logger } from '../logger.ts';

export interface HttpServerOptions {
  readonly logger: Logger;
  readonly maxUploadBytes: number;
  readonly readinessChecks: Record<string, () => Promise<unknown>>;
}

function statusFor(error: DomainError): number {
  if (error instanceof NotFoundError) return 404;
  if (error instanceof ValidationError) return 422;
  if (error instanceof ConflictError) return 409;
  return 400;
}

export async function createHttpServer(options: HttpServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: options.logger as FastifyBaseLogger,
    logController: new LogController({
      disableRequestLogging: (req) => req.url.startsWith('/health/'),
    }),
    requestIdHeader: 'x-request-id',
  });

  await app.register(multipart, { limits: { fileSize: options.maxUploadBytes, files: 1 } });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      return reply.status(statusFor(error)).send({ error: error.code, message: error.message });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: 'BAD_REQUEST', issues: error.issues });
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) request.log.error({ err: error }, 'unhandled error');
    return reply.status(status).send({
      error: status >= 500 ? 'INTERNAL' : 'BAD_REQUEST',
      message: status >= 500 ? 'Internal Server Error' : (error as Error).message,
    });
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    const results = await Promise.allSettled(
      Object.entries(options.readinessChecks).map(async ([name, check]) => {
        await check();
        return name;
      }),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    return reply.status(failed ? 503 : 200).send({ status: failed ? 'unavailable' : 'ok' });
  });

  return app;
}
