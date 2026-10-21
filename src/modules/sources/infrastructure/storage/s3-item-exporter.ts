import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { ExportLine, ItemExporter } from '../../application/ports.ts';
import type { ExportedItem } from '../../contracts/index.ts';
import type { RunId } from '../../domain/run-id.ts';

/** Writes the claim-check file described in the contract: `sources/exports/<runId>.jsonl`. */
export class S3ItemExporter implements ItemExporter {
  readonly #s3: S3Client;
  readonly #bucket: string;
  readonly #prefix: string;

  constructor(s3: S3Client, bucket: string, prefix = 'sources/') {
    this.#s3 = s3;
    this.#bucket = bucket;
    this.#prefix = prefix;
  }

  async write(runId: RunId, lines: readonly ExportLine[]): Promise<string> {
    const key = `${this.#prefix}exports/${runId}.jsonl`;
    const body = new TextEncoder().encode(
      lines.map((line) => `${JSON.stringify(toExportedItem(line))}\n`).join(''),
    );
    await this.#s3.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: body,
        ContentType: 'application/x-ndjson',
        ContentLength: body.byteLength,
      }),
    );
    return key;
  }
}

function toExportedItem({ item, sourceName, text }: ExportLine): ExportedItem {
  return {
    itemId: item.id,
    sourceId: item.sourceId,
    sourceName,
    kind: item.kind,
    url: item.url,
    title: item.title,
    publishedAt: item.publishedAt?.toISOString() ?? null,
    text,
  };
}
