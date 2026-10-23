import type { Response } from 'undici';
import { SourceFetchError } from '../../domain/errors.ts';

/** Reads a response body, failing (and stopping the download) once it exceeds `maxBytes`. */
export async function readBody(
  response: Response,
  url: URL | string,
  maxBytes: number,
): Promise<Uint8Array> {
  const tooLarge = () => new SourceFetchError(`${url} is larger than ${maxBytes} bytes`);
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    // Leaving the loop cancels the stream, so the rest is never downloaded
    if (size > maxBytes) throw tooLarge();
    chunks.push(chunk);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
