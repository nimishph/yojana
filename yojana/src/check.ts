import {
  type ClaimResult,
  foldLog,
  type StorePort,
  type VerifierPort,
} from '@cntxt-labs/yojana-core';

/**
 * Check: run every claim of every plan (or one plan) through the verifier for its kind. Claims
 * come from the log, the source of truth, so an unrecorded edit to a plan file is not checked
 * until it is ingested. A kind with no verifier is unverifiable, never assumed to hold.
 */

export interface PlanCheck {
  readonly planId: string;
  readonly results: readonly ClaimResult[];
}

export interface CheckReport {
  readonly plans: readonly PlanCheck[];
  readonly holds: number;
  readonly violated: number;
  readonly unverifiable: number;
}

export async function check(options: {
  readonly store: StorePort;
  readonly verifiers: readonly VerifierPort[];
  readonly planId?: string | undefined;
}): Promise<CheckReport> {
  const state = foldLog(await options.store.events());
  const byKind = new Map<string, VerifierPort>();
  for (const verifier of options.verifiers) {
    for (const kind of verifier.kinds) byKind.set(kind, verifier);
  }
  const known = [...byKind.keys()].sort().join(', ');

  const plans: PlanCheck[] = [];
  for (const plan of state.plans.values()) {
    if (options.planId !== undefined && plan.id !== options.planId) continue;
    const results: ClaimResult[] = [];
    for (const requirement of plan.heads.values()) {
      for (const claim of requirement.claims) {
        const verifier = byKind.get(claim.kind);
        results.push(
          verifier === undefined
            ? {
                requirement: requirement.id,
                claim,
                outcome: 'unverifiable',
                evidence: `no verifier for kind "${claim.kind}"; known kinds: ${known}`,
              }
            : await verifier.verify(requirement.id, claim),
        );
      }
    }
    plans.push({ planId: plan.id, results });
  }

  const count = (outcome: ClaimResult['outcome']) =>
    plans.reduce((n, p) => n + p.results.filter((r) => r.outcome === outcome).length, 0);
  return {
    plans,
    holds: count('holds'),
    violated: count('violated'),
    unverifiable: count('unverifiable'),
  };
}
