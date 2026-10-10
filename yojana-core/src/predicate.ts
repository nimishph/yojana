export type ScalarPredicate =
  | { readonly eq: unknown }
  | { readonly gte: number }
  | { readonly lte: number }
  | { readonly gt?: number }
  | { readonly lt?: number }
  | { readonly in: readonly unknown[] };

export type ClaimPredicate = boolean | ScalarPredicate | { readonly [key: string]: unknown };

/**
 * A checkable statement about the code. `kind` names the verifier that understands it.
 * Either a shorthand {kind, expression, expect: bool} or a structured claim
 * {kind, params, expect: predicate}.
 */
export interface Claim {
  readonly kind: string;
  readonly expression?: string | undefined;
  readonly params?: Readonly<Record<string, unknown>> | undefined;
  /** Expected outcome: boolean shorthand or predicate over measurements. */
  readonly expect: ClaimPredicate;
  /** Child claims for composite claims ('all', 'any', 'not'). */
  readonly claims?: readonly Claim[] | undefined;
}

export const COMPOSITE_CLAIM_KINDS = ['all', 'any', 'not'] as const;
export type CompositeClaimKind = (typeof COMPOSITE_CLAIM_KINDS)[number];

export function isCompositeClaimKind(kind: string): kind is CompositeClaimKind {
  return kind === 'all' || kind === 'any' || kind === 'not';
}

/**
 * Evaluates a predicate against measurements returned by a verifier.
 * Supported predicates:
 * - boolean: truthy/falsy measurement check
 * - scalar operators: { eq, gte, lte, gt, lt, in }
 * - multi-field record: { status: { in: ['trusted', 'active'] }, trust: { gte: 0.7 } }
 */
export function evaluatePredicate(predicate: ClaimPredicate, measurement: unknown): boolean {
  if (typeof predicate === 'boolean') {
    if (typeof measurement === 'boolean') {
      return measurement === predicate;
    }
    if (typeof measurement === 'number') {
      return predicate ? measurement > 0 : measurement === 0;
    }
    if (Array.isArray(measurement)) {
      return predicate ? measurement.length > 0 : measurement.length === 0;
    }
    if (measurement !== null && typeof measurement === 'object') {
      const record = measurement as Record<string, unknown>;
      if ('count' in record && typeof record.count === 'number') {
        return predicate ? record.count > 0 : record.count === 0;
      }
      if ('found' in record && typeof record.found === 'boolean') {
        return record.found === predicate;
      }
      if ('matches' in record && Array.isArray(record.matches)) {
        return predicate ? record.matches.length > 0 : record.matches.length === 0;
      }
      return predicate;
    }
    return Boolean(measurement) === predicate;
  }

  if (predicate !== null && typeof predicate === 'object') {
    const predObj = predicate as Record<string, unknown>;

    const isScalarOp =
      'eq' in predObj ||
      'gte' in predObj ||
      'lte' in predObj ||
      'gt' in predObj ||
      'lt' in predObj ||
      'in' in predObj;

    if (isScalarOp) {
      let val = measurement;
      if (measurement !== null && typeof measurement === 'object' && !Array.isArray(measurement)) {
        const mObj = measurement as Record<string, unknown>;
        if ('count' in mObj && typeof mObj.count === 'number') {
          val = mObj.count;
        } else if ('value' in mObj) {
          val = mObj.value;
        }
      }

      if ('eq' in predObj && val !== predObj.eq) return false;
      if ('gte' in predObj && (typeof val !== 'number' || val < (predObj.gte as number)))
        return false;
      if ('lte' in predObj && (typeof val !== 'number' || val > (predObj.lte as number)))
        return false;
      if ('gt' in predObj && (typeof val !== 'number' || val <= (predObj.gt as number)))
        return false;
      if ('lt' in predObj && (typeof val !== 'number' || val >= (predObj.lt as number)))
        return false;
      if ('in' in predObj) {
        const inList = predObj.in;
        if (!Array.isArray(inList) || !inList.includes(val)) return false;
      }
      return true;
    }

    if (measurement === null || typeof measurement !== 'object') {
      return false;
    }
    const mObj = measurement as Record<string, unknown>;
    for (const [key, subPred] of Object.entries(predObj)) {
      const actualVal = mObj[key];
      if (typeof subPred === 'object' && subPred !== null) {
        if (!evaluatePredicate(subPred as ClaimPredicate, actualVal)) return false;
      } else {
        if (actualVal !== subPred) return false;
      }
    }
    return true;
  }

  return false;
}

export function formatExpectation(expect: ClaimPredicate): string {
  if (expect === true) return '';
  if (expect === false) return ' (expect none)';
  if (typeof expect === 'object' && expect !== null) {
    const entries = Object.entries(expect);
    const first = entries[0];
    if (
      entries.length === 1 &&
      first !== undefined &&
      ['eq', 'gte', 'lte', 'gt', 'lt', 'in'].includes(first[0])
    ) {
      const [op, val] = first;
      const opSymbol = op === 'eq' ? '==' : op === 'gte' ? '>=' : op === 'lte' ? '<=' : op;
      return ` (expect ${opSymbol} ${Array.isArray(val) ? `[${val.join(', ')}]` : String(val)})`;
    }
    const formatted = entries
      .map(([k, v]) => {
        if (typeof v === 'object' && v !== null) {
          const subEntries = Object.entries(v);
          const firstSub = subEntries[0];
          if (
            subEntries.length === 1 &&
            firstSub !== undefined &&
            ['eq', 'gte', 'lte', 'gt', 'lt', 'in'].includes(firstSub[0])
          ) {
            const [op, val] = firstSub;
            const opSymbol = op === 'eq' ? '==' : op === 'gte' ? '>=' : op === 'lte' ? '<=' : op;
            return `${k} ${opSymbol} ${Array.isArray(val) ? `[${val.join(', ')}]` : String(val)}`;
          }
        }
        return `${k}=${String(v)}`;
      })
      .join(', ');
    return ` (expect ${formatted})`;
  }
  return ` (expect ${String(expect)})`;
}

export function describeClaim(claim: Claim): string {
  if (isCompositeClaimKind(claim.kind)) {
    const sub = (claim.claims ?? []).map(describeClaim).join(', ');
    const exp = formatExpectation(claim.expect);
    return `${claim.kind}(${sub})${exp !== '' ? ` ${exp.trim()}` : ''}`;
  }
  const parts = [claim.kind];
  if (claim.expression !== undefined && claim.expression.trim() !== '') {
    parts.push(claim.expression.trim());
  }
  if (claim.params !== undefined) {
    const paramEntries = Object.entries(claim.params);
    if (paramEntries.length > 0) {
      parts.push(
        paramEntries
          .map(([k, v]) => `${k}=${typeof v === 'object' && v !== null ? JSON.stringify(v) : v}`)
          .join(' '),
      );
    }
  }
  const exp = formatExpectation(claim.expect);
  if (exp !== '') parts.push(exp.trim());
  return parts.join(' ');
}
