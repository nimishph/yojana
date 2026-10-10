import {
  type Claim,
  type ClaimCachePort,
  type ClaimOutcome,
  type ClaimResult,
  computeClaimCacheKey,
  describeClaim,
  evaluateClaimOutcome,
  evaluatePredicate,
  foldLog,
  getClaimKindDescriptor,
  isCompositeClaimKind,
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

export interface CheckOptions {
  readonly store: StorePort;
  readonly verifiers: readonly VerifierPort[];
  readonly planId?: string | undefined;
  readonly cache?: ClaimCachePort | undefined;
}

async function verifyOneClaim(
  requirementId: string,
  actionId: string | undefined,
  claim: Claim,
  byKind: ReadonlyMap<string, VerifierPort>,
  known: string,
  cache?: ClaimCachePort | undefined,
): Promise<ClaimResult> {
  if (isCompositeClaimKind(claim.kind)) {
    const childClaims = claim.claims ?? [];
    if (childClaims.length === 0) {
      return {
        requirement: requirementId,
        ...(actionId !== undefined ? { action: actionId } : {}),
        claim,
        outcome: 'unverifiable',
        evidence: `composite claim "${claim.kind}" has no child claims`,
        deterministic: true,
      };
    }

    const childResults = await Promise.all(
      childClaims.map((c) => verifyOneClaim(requirementId, actionId, c, byKind, known, cache)),
    );

    let baseOutcome: ClaimOutcome;
    let evidence: string;

    if (claim.kind === 'all') {
      const anyViolated = childResults.some((r) => r.outcome === 'violated');
      const anyUnverifiable = childResults.some((r) => r.outcome === 'unverifiable');
      if (anyViolated) {
        baseOutcome = 'violated';
      } else if (anyUnverifiable) {
        baseOutcome = 'unverifiable';
      } else {
        baseOutcome = 'holds';
      }

      const held = childResults.filter((r) => r.outcome === 'holds').length;
      evidence =
        baseOutcome === 'holds'
          ? `all ${childResults.length} claims hold:\n` +
            childResults
              .map((r, i) => `  ${i + 1}. [holds] ${describeClaim(r.claim)}: ${r.evidence}`)
              .join('\n')
          : `${childResults.length - held} of ${childResults.length} claims not holding:\n` +
            childResults
              .map((r, i) => `  ${i + 1}. [${r.outcome}] ${describeClaim(r.claim)}: ${r.evidence}`)
              .join('\n');
    } else if (claim.kind === 'any') {
      const anyHolds = childResults.some((r) => r.outcome === 'holds');
      const anyUnverifiable = childResults.some((r) => r.outcome === 'unverifiable');
      if (anyHolds) {
        baseOutcome = 'holds';
      } else if (anyUnverifiable) {
        baseOutcome = 'unverifiable';
      } else {
        baseOutcome = 'violated';
      }

      const held = childResults.filter((r) => r.outcome === 'holds').length;
      evidence =
        baseOutcome === 'holds'
          ? `${held} of ${childResults.length} claims hold:\n` +
            childResults
              .map((r, i) => `  ${i + 1}. [${r.outcome}] ${describeClaim(r.claim)}: ${r.evidence}`)
              .join('\n')
          : `all ${childResults.length} claims violated:\n` +
            childResults
              .map((r, i) => `  ${i + 1}. [${r.outcome}] ${describeClaim(r.claim)}: ${r.evidence}`)
              .join('\n');
    } else {
      // not
      const child = childResults[0];
      if (child === undefined) {
        baseOutcome = 'unverifiable';
        evidence = 'not claim has no child claim';
      } else {
        if (child.outcome === 'holds') {
          baseOutcome = 'violated';
        } else if (child.outcome === 'violated') {
          baseOutcome = 'holds';
        } else {
          baseOutcome = 'unverifiable';
        }
        evidence = `not (${describeClaim(child.claim)}): child is ${child.outcome} (${child.evidence})`;
      }
    }

    const heldCount = childResults.filter((r) => r.outcome === 'holds').length;
    const measurements = { count: heldCount, total: childResults.length };
    let outcome = baseOutcome;
    if (baseOutcome !== 'unverifiable') {
      if (claim.expect === false) {
        outcome = baseOutcome === 'holds' ? 'violated' : 'holds';
      } else if (typeof claim.expect === 'object' && claim.expect !== null) {
        outcome = evaluatePredicate(claim.expect, measurements) ? 'holds' : 'violated';
      }
    }

    const deterministic = childResults.every((r) => r.deterministic !== false);
    const measuredAt = deterministic
      ? undefined
      : Math.max(...childResults.map((r) => r.measuredAt ?? 0)) || Date.now();

    return {
      requirement: requirementId,
      ...(actionId !== undefined ? { action: actionId } : {}),
      claim,
      outcome,
      evidence,
      measurements,
      deterministic,
      ...(measuredAt !== undefined ? { measuredAt } : {}),
    };
  }

  const verifier = byKind.get(claim.kind);
  if (verifier === undefined) {
    return {
      requirement: requirementId,
      ...(actionId !== undefined ? { action: actionId } : {}),
      claim,
      outcome: 'unverifiable',
      evidence: `no verifier for kind "${claim.kind}"; known kinds: ${known}`,
      deterministic: true,
    };
  }

  const descriptor = await getClaimKindDescriptor(verifier, claim.kind);
  const deterministic = descriptor?.deterministic ?? true;

  if (deterministic && cache !== undefined) {
    const indexState = await verifier.indexState?.();
    const cacheKey = computeClaimCacheKey({
      requirement: requirementId,
      action: actionId,
      claim,
      adapterVersion: descriptor?.version ?? verifier.name,
      indexState,
    });
    const cached = await cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const raw = await verifier.verify(requirementId, claim);
    const outcome = evaluateClaimOutcome(claim, raw);
    const result: ClaimResult = {
      ...raw,
      requirement: requirementId,
      ...(actionId !== undefined ? { action: actionId } : {}),
      outcome,
      deterministic: true,
    };
    await cache.set(cacheKey, result);
    return result;
  }

  const raw = await verifier.verify(requirementId, claim);
  const outcome = evaluateClaimOutcome(claim, raw);
  const result: ClaimResult = {
    ...raw,
    requirement: requirementId,
    ...(actionId !== undefined ? { action: actionId } : {}),
    outcome,
    deterministic,
    ...(deterministic ? {} : { measuredAt: raw.measuredAt ?? Date.now() }),
  };
  return result;
}

export async function check(options: CheckOptions): Promise<CheckReport> {
  const state = foldLog(await options.store.events());
  const byKind = new Map<string, VerifierPort>();
  for (const verifier of options.verifiers) {
    if (verifier.kinds.length === 0 && typeof verifier.describe === 'function') {
      const desc = await verifier.describe();
      for (const kind of desc.kinds) byKind.set(kind.kind, verifier);
    } else {
      for (const kind of verifier.kinds) byKind.set(kind, verifier);
    }
  }
  const known = [...byKind.keys()].sort().join(', ');

  const plans: PlanCheck[] = [];
  for (const plan of state.plans.values()) {
    if (options.planId !== undefined && plan.id !== options.planId) continue;
    const results: ClaimResult[] = [];
    for (const requirement of plan.heads.values()) {
      for (const claim of requirement.claims) {
        results.push(
          await verifyOneClaim(requirement.id, undefined, claim, byKind, known, options.cache),
        );
      }
      for (const action of requirement.actions ?? []) {
        for (const claim of action.claims ?? []) {
          results.push(
            await verifyOneClaim(requirement.id, action.id, claim, byKind, known, options.cache),
          );
        }
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
