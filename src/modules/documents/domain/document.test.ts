import { describe, expect, it } from 'vitest';
import { Document, type DocumentId } from './document.ts';
import { InvalidDocumentError, InvalidDocumentStateError } from './errors.ts';

const now = new Date('2026-01-01T00:00:00Z');
const upload = (overrides: Partial<Parameters<typeof Document.upload>[0]> = {}) =>
  Document.upload({
    id: 'doc-1' as DocumentId,
    filename: 'report.pdf',
    contentType: 'application/pdf',
    sizeBytes: 42,
    uploadedBy: 'ada@example.com',
    now,
    ...overrides,
  });

describe('Document', () => {
  it('starts in uploaded state', () => {
    expect(upload().toSnapshot()).toMatchObject({ status: 'uploaded', checksum: null });
  });

  it.each([
    [{ filename: '  ' }, 'filename is required'],
    [{ sizeBytes: 0 }, 'document is empty'],
    [{ uploadedBy: 'nope' }, 'uploadedBy must be an email'],
  ])('rejects invalid input %o', (overrides, message) => {
    expect(() => upload(overrides)).toThrow(new InvalidDocumentError(message));
  });

  it('goes through processing to processed', () => {
    const doc = upload();
    doc.startProcessing(now);
    doc.completeProcessing('abc', now);
    expect(doc.toSnapshot()).toMatchObject({ status: 'processed', checksum: 'abc' });
  });

  it('can be reprocessed after a failure but not after success', () => {
    const doc = upload();
    doc.startProcessing(now);
    doc.fail('boom', now);
    doc.startProcessing(now);
    expect(doc.status).toBe('processing');

    doc.completeProcessing('abc', now);
    expect(() => doc.startProcessing(now)).toThrow(InvalidDocumentStateError);
    expect(() => doc.fail('late', now)).toThrow(InvalidDocumentStateError);
  });
});
