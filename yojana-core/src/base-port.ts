import type { PlanStatus } from './model.ts';
import type { RequirementId, RevisionHash } from './revision.ts';

/**
 * BasePort: what a plan file looked like the last time it and the log agreed, much as git's index
 * records what the working tree was last staged from. Ingest compares three things per
 * requirement (the file, this base, the log) to tell an edit apart from a file that has fallen
 * behind, and to refuse when both moved.
 *
 * Bases are kept beside the plans (committed with them), so a fresh clone carries them too.
 */
export interface PlanBase {
  readonly planId: string;
  readonly status: PlanStatus | undefined;
  readonly revisions: Readonly<Record<RequirementId, RevisionHash>>;
}

export interface BasePort {
  readonly name: string;
  get(planId: string): Promise<PlanBase | undefined>;
  set(base: PlanBase): Promise<void>;
}
