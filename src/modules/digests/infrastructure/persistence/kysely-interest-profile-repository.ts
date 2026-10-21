import type { Kysely } from 'kysely';
import { InterestProfile } from '../../domain/interest-profile.ts';
import type { InterestProfileRepository } from '../../domain/repositories.ts';
import type { DigestsTables } from './tables.ts';

export class KyselyInterestProfileRepository implements InterestProfileRepository {
  readonly #db: Kysely<DigestsTables>;

  constructor(db: Kysely<DigestsTables>) {
    this.#db = db;
  }

  async find(ownerId: string): Promise<InterestProfile | undefined> {
    const row = await this.#db
      .selectFrom('digests.interest_profile')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    return (
      row &&
      InterestProfile.restore({
        ownerId: row.owner_id,
        interests: row.interests,
        relevanceThreshold: row.relevance_threshold,
        updatedAt: row.updated_at,
      })
    );
  }

  async save(profile: InterestProfile): Promise<void> {
    const s = profile.toSnapshot();
    const changes = {
      interests: s.interests,
      relevance_threshold: s.relevanceThreshold,
      updated_at: s.updatedAt,
    };
    await this.#db
      .insertInto('digests.interest_profile')
      .values({ owner_id: s.ownerId, ...changes })
      .onConflict((oc) => oc.column('owner_id').doUpdateSet(changes))
      .execute();
  }
}
