import { S3Client } from '@aws-sdk/client-s3';
import type { AppConfig } from '../config.ts';

export function createS3Client(config: AppConfig): S3Client {
  return new S3Client({
    region: config.s3.region,
    forcePathStyle: config.s3.forcePathStyle,
    ...(config.s3.endpoint ? { endpoint: config.s3.endpoint } : {}),
  });
}
