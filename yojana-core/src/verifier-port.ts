import type { Claim } from './model.ts';
import type { RequirementId } from './revision.ts';

export type ClaimOutcome = 'holds' | 'violated' | 'unverifiable';

export interface ClaimResult {
  readonly requirement: RequirementId;
  readonly claim: Claim;
  readonly outcome: ClaimOutcome;
  /** What the verifier saw: matches found, the command's output, or why it could not check. */
  readonly evidence: string;
}

/** Checks claims against the code. anvesa (WQL, dependents) first; a shell command as fallback. */
export interface VerifierPort {
  readonly name: string;
  readonly kinds: readonly string[];
  verify(requirement: RequirementId, claim: Claim): Promise<ClaimResult>;
}
