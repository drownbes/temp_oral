import { failOnDomainError } from '#shared/infrastructure/temporal/errors.ts';
import type { BeginDigest, BeginDigestCommand } from '../../application/begin-digest.ts';
import type { CheckEnrichment } from '../../application/check-enrichment.ts';
import type { CheckSynthesis } from '../../application/check-synthesis.ts';
import type {
  ComposeNotification,
  DigestEvent,
  DigestNotification,
} from '../../application/compose-notification.ts';
import type { DigestState } from '../../application/digest-state.ts';
import type { IngestEnrichment } from '../../application/ingest-enrichment.ts';
import type { IngestSynthesis } from '../../application/ingest-synthesis.ts';
import type { MarkDigestFailed } from '../../application/mark-digest-failed.ts';
import type { PublishDigest } from '../../application/publish-digest.ts';
import type { RecordCollection } from '../../application/record-collection.ts';
import type { SubmitEnrichment } from '../../application/submit-enrichment.ts';
import type { SubmitSynthesis } from '../../application/submit-synthesis.ts';
import type { CollectionOutcome, DigestId } from '../../domain/digest.ts';

/** Inbound adapter: Temporal activities are thin wrappers that call use cases. */
export function createDigestActivities(useCases: {
  beginDigest: BeginDigest;
  recordCollection: RecordCollection;
  submitEnrichment: SubmitEnrichment;
  checkEnrichment: CheckEnrichment;
  ingestEnrichment: IngestEnrichment;
  submitSynthesis: SubmitSynthesis;
  checkSynthesis: CheckSynthesis;
  ingestSynthesis: IngestSynthesis;
  publishDigest: PublishDigest;
  markDigestFailed: MarkDigestFailed;
  composeNotification: ComposeNotification;
}) {
  const id = (digestId: string) => digestId as DigestId;
  return {
    beginDigest(command: BeginDigestCommand): Promise<DigestState> {
      return failOnDomainError(() => useCases.beginDigest.execute(command));
    },
    recordCollection(digestId: string, outcome: CollectionOutcome): Promise<DigestState> {
      return failOnDomainError(() => useCases.recordCollection.execute(id(digestId), outcome));
    },
    submitEnrichment(digestId: string): Promise<DigestState> {
      return failOnDomainError(() => useCases.submitEnrichment.execute(id(digestId)));
    },
    checkEnrichment(digestId: string): Promise<{ done: boolean }> {
      return failOnDomainError(() => useCases.checkEnrichment.execute(id(digestId)));
    },
    ingestEnrichment(digestId: string): Promise<DigestState> {
      return failOnDomainError(() => useCases.ingestEnrichment.execute(id(digestId)));
    },
    submitSynthesis(digestId: string): Promise<DigestState> {
      return failOnDomainError(() => useCases.submitSynthesis.execute(id(digestId)));
    },
    checkSynthesis(digestId: string): Promise<{ done: boolean }> {
      return failOnDomainError(() => useCases.checkSynthesis.execute(id(digestId)));
    },
    ingestSynthesis(digestId: string): Promise<DigestState> {
      return failOnDomainError(() => useCases.ingestSynthesis.execute(id(digestId)));
    },
    publishDigest(digestId: string): Promise<DigestState> {
      return failOnDomainError(() => useCases.publishDigest.execute(id(digestId)));
    },
    markDigestFailed(digestId: string, reason: string): Promise<void> {
      return failOnDomainError(() => useCases.markDigestFailed.execute(id(digestId), reason));
    },
    composeNotification(digestId: string, event: DigestEvent): Promise<DigestNotification | null> {
      return failOnDomainError(() => useCases.composeNotification.execute(id(digestId), event));
    },
  };
}

export type DigestActivities = ReturnType<typeof createDigestActivities>;
