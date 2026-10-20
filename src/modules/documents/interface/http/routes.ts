import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { GetDocument } from '../../application/get-document.ts';
import type { UploadDocument } from '../../application/upload-document.ts';
import type { DocumentId, DocumentSnapshot } from '../../domain/document.ts';

const DocumentParams = z.object({ id: z.uuid() });

const toDto = (d: DocumentSnapshot) => ({
  id: d.id,
  filename: d.filename,
  contentType: d.contentType,
  sizeBytes: d.sizeBytes,
  uploadedBy: d.uploadedBy,
  status: d.status,
  checksum: d.checksum,
  failureReason: d.failureReason,
  createdAt: d.createdAt.toISOString(),
  updatedAt: d.updatedAt.toISOString(),
});

export function documentRoutes(useCases: {
  upload: UploadDocument;
  get: GetDocument;
}): FastifyPluginAsync {
  // Named so @fastify/otel spans read "handler - documentsHttp" instead of the source text
  return async function documentsHttp(app) {
    // multipart/form-data with an `uploadedBy` field followed by a `file` part
    app.post('/documents', async (request, reply) => {
      const file = await request.file();
      if (!file)
        return reply.status(400).send({ error: 'BAD_REQUEST', message: 'file is required' });

      const uploadedBy = file.fields.uploadedBy;
      const document = await useCases.upload.execute({
        filename: file.filename,
        contentType: file.mimetype,
        content: await file.toBuffer(),
        uploadedBy:
          uploadedBy && !Array.isArray(uploadedBy) && uploadedBy.type === 'field'
            ? String(uploadedBy.value)
            : '',
      });
      return reply
        .status(201)
        .header('location', `/documents/${document.id}`)
        .send(toDto(document));
    });

    app.get('/documents/:id', async (request) => {
      const { id } = DocumentParams.parse(request.params);
      return toDto(await useCases.get.execute(id as DocumentId));
    });
  };
}
