import type { Clock } from '#shared/kernel/clock.ts';
import { InterestProfile, type InterestProfileSnapshot } from '../domain/interest-profile.ts';
import type { InterestProfileRepository } from '../domain/repositories.ts';

export interface InterestProfileDeps {
  readonly profiles: InterestProfileRepository;
  readonly clock: Clock;
}

export class GetInterestProfile {
  readonly #deps: InterestProfileDeps;

  constructor(deps: InterestProfileDeps) {
    this.#deps = deps;
  }

  async execute(ownerId: string): Promise<InterestProfileSnapshot> {
    const profile = await this.#deps.profiles.find(ownerId);
    return (profile ?? InterestProfile.initial(ownerId, this.#deps.clock.now())).toSnapshot();
  }
}

export class UpdateInterestProfile {
  readonly #deps: InterestProfileDeps;

  constructor(deps: InterestProfileDeps) {
    this.#deps = deps;
  }

  async execute(
    ownerId: string,
    changes: { interests?: string; relevanceThreshold?: number },
  ): Promise<InterestProfileSnapshot> {
    const { profiles, clock } = this.#deps;
    const profile = (await profiles.find(ownerId)) ?? InterestProfile.initial(ownerId, clock.now());
    profile.change(changes, clock.now());
    await profiles.save(profile);
    return profile.toSnapshot();
  }
}
