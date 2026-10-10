import type { Claim } from './predicate.ts';
import { evaluatePredicate } from './predicate.ts';
import { type ActionId, canonicalClaim, type RequirementId } from './revision.ts';

export type ClaimOutcome = 'holds' | 'violated' | 'unverifiable';

export type ParamType = 'string' | 'number' | 'boolean' | 'array' | 'object';

export interface ParamSchema {
  readonly type: ParamType;
  readonly required?: boolean | undefined;
  readonly description?: string | undefined;
}

export interface ClaimKindDescriptor {
  readonly kind: string;
  readonly description?: string | undefined;
  /** Whether shorthand expression is supported. */
  readonly expression?: boolean | undefined;
  /** Parameter schemas for structured claims of this kind. */
  readonly params?: Readonly<Record<string, ParamSchema>> | undefined;
  /**
   * Whether checking this claim is deterministic: checking the same commit/state
   * always produces the same outcome. When false (e.g. medha trust, drift, semantic search),
   * the claim carries `measuredAt` and does not drive close?/reopen? or --strict.
   */
  readonly deterministic: boolean;
  /** Version of the verifier / logic for this kind, for cache key invalidation. */
  readonly version?: string | undefined;
}

export interface VerifierDescriptor {
  readonly name: string;
  readonly version?: string | undefined;
  readonly kinds: readonly ClaimKindDescriptor[];
}

export interface ClaimResult {
  readonly requirement: RequirementId;
  /** The action this claim belongs to, when under an action rather than the requirement. */
  readonly action?: ActionId | undefined;
  readonly claim: Claim;
  readonly outcome: ClaimOutcome;
  /** What the verifier saw: matches found, the command's output, or why it could not check. */
  readonly evidence: string;
  /** Measurements returned by the verifier (e.g. count, score, matches). */
  readonly measurements?: Readonly<Record<string, unknown>> | undefined;
  /** Whether the claim evaluation is deterministic (from adapter's ClaimKindDescriptor). */
  readonly deterministic?: boolean | undefined;
  /** When this claim was measured (timestamp in ms), especially for time-dependent ones. */
  readonly measuredAt?: number | undefined;
}

export interface ClaimCachePort {
  get(key: string): ClaimResult | Promise<ClaimResult | undefined> | undefined;
  set(key: string, result: ClaimResult): void | Promise<void>;
}

/** Checks claims against the code. anvesa (WQL, dependents) first; a shell command as fallback. */
export interface VerifierPort {
  readonly name: string;
  readonly kinds: readonly string[];
  describe?(): VerifierDescriptor | Promise<VerifierDescriptor>;
  /** Index state token (commit hash, index timestamp, etc.) for cache invalidation. */
  indexState?(): Promise<string | undefined> | string | undefined;
  verify(requirement: RequirementId, claim: Claim): Promise<ClaimResult>;
}

export function computeClaimCacheKey(options: {
  readonly requirement: RequirementId;
  readonly action?: ActionId | undefined;
  readonly claim: Claim;
  readonly adapterVersion?: string | undefined;
  readonly indexState?: string | undefined;
}): string {
  const parts = [
    options.requirement,
    options.action ?? '',
    canonicalClaim(options.claim),
    options.adapterVersion ?? '',
    options.indexState ?? '',
  ];
  return parts.join('::');
}

export async function getClaimKindDescriptor(
  verifier: VerifierPort | undefined,
  kind: string,
): Promise<ClaimKindDescriptor | undefined> {
  if (verifier === undefined) return undefined;
  if (typeof verifier.describe === 'function') {
    const desc = await verifier.describe();
    const found = desc.kinds.find((k) => k.kind === kind);
    if (found !== undefined) return found;
  }
  return {
    kind,
    expression: true,
    deterministic: true,
    version: verifier.name,
  };
}

export interface ClaimValidationError {
  readonly code:
    | 'UNKNOWN_CLAIM_KIND'
    | 'INVALID_CLAIM'
    | 'MISSING_CLAIM_PARAM'
    | 'UNKNOWN_CLAIM_PARAM'
    | 'INVALID_CLAIM_PARAM';
  readonly message: string;
}

export function validateClaimSchema(
  claim: Claim,
  descriptor: ClaimKindDescriptor,
): readonly ClaimValidationError[] {
  const errors: ClaimValidationError[] = [];

  if (claim.expression !== undefined && descriptor.expression !== true) {
    if (!descriptor.params || !('expression' in descriptor.params)) {
      errors.push({
        code: 'INVALID_CLAIM',
        message: `claim kind "${descriptor.kind}" does not support expression shorthand; use parameters`,
      });
    }
  }

  if (descriptor.params !== undefined) {
    for (const [paramName, schema] of Object.entries(descriptor.params)) {
      if (schema.required) {
        const val = claim.params?.[paramName];
        const hasExpr = claim.expression !== undefined && descriptor.expression === true;
        if (val === undefined && !hasExpr) {
          errors.push({
            code: 'MISSING_CLAIM_PARAM',
            message: `claim kind "${descriptor.kind}" requires parameter "${paramName}"`,
          });
        }
      }
    }

    if (claim.params !== undefined) {
      for (const [paramName, val] of Object.entries(claim.params)) {
        const schema = descriptor.params[paramName];
        if (schema === undefined) {
          const known = Object.keys(descriptor.params).sort().join(', ');
          errors.push({
            code: 'UNKNOWN_CLAIM_PARAM',
            message: `unknown parameter "${paramName}" for claim kind "${descriptor.kind}"; known parameters: ${known}`,
          });
        } else {
          let valid = true;
          switch (schema.type) {
            case 'string':
              valid = typeof val === 'string';
              break;
            case 'number':
              valid = typeof val === 'number';
              break;
            case 'boolean':
              valid = typeof val === 'boolean';
              break;
            case 'array':
              valid = Array.isArray(val);
              break;
            case 'object':
              valid = typeof val === 'object' && val !== null && !Array.isArray(val);
              break;
          }
          if (!valid) {
            errors.push({
              code: 'INVALID_CLAIM_PARAM',
              message: `parameter "${paramName}" on claim kind "${descriptor.kind}" must be ${schema.type}, got ${Array.isArray(val) ? 'array' : typeof val}`,
            });
          }
        }
      }
    }
  }

  return errors;
}

/**
 * Resolves a claim outcome: unverifiable stays unverifiable; if measurements are
 * provided, yojana-core evaluates the claim's expect predicate against them.
 */
export function evaluateClaimOutcome(
  claim: Claim,
  result: Pick<ClaimResult, 'outcome'> & {
    readonly measurements?: Readonly<Record<string, unknown>> | undefined;
  },
): ClaimOutcome {
  if (result.outcome === 'unverifiable') {
    return 'unverifiable';
  }
  if (result.measurements !== undefined) {
    return evaluatePredicate(claim.expect, result.measurements) ? 'holds' : 'violated';
  }
  return result.outcome;
}
