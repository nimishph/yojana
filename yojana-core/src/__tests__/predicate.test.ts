import { describe, expect, test } from 'bun:test';
import type { Claim } from '../model.ts';
import { describeClaim, evaluatePredicate, formatExpectation } from '../predicate.ts';
import { canonicalClaim } from '../revision.ts';
import { evaluateClaimOutcome } from '../verifier-port.ts';

describe('evaluatePredicate', () => {
  test('evaluates boolean predicates against various measurement types', () => {
    expect(evaluatePredicate(true, true)).toBe(true);
    expect(evaluatePredicate(false, false)).toBe(true);
    expect(evaluatePredicate(true, false)).toBe(false);

    // Number count
    expect(evaluatePredicate(true, 5)).toBe(true);
    expect(evaluatePredicate(true, 0)).toBe(false);
    expect(evaluatePredicate(false, 0)).toBe(true);
    expect(evaluatePredicate(false, 3)).toBe(false);

    // Array
    expect(evaluatePredicate(true, ['a'])).toBe(true);
    expect(evaluatePredicate(true, [])).toBe(false);
    expect(evaluatePredicate(false, [])).toBe(true);

    // Record with count, found, matches
    expect(evaluatePredicate(true, { count: 3 })).toBe(true);
    expect(evaluatePredicate(true, { count: 0 })).toBe(false);
    expect(evaluatePredicate(false, { count: 0 })).toBe(true);
    expect(evaluatePredicate(true, { found: true })).toBe(true);
    expect(evaluatePredicate(false, { found: false })).toBe(true);
    expect(evaluatePredicate(true, { matches: ['x'] })).toBe(true);
    expect(evaluatePredicate(false, { matches: [] })).toBe(true);
  });

  test('evaluates scalar operators on numbers and measurements with count', () => {
    expect(evaluatePredicate({ gte: 2 }, 3)).toBe(true);
    expect(evaluatePredicate({ gte: 2 }, 2)).toBe(true);
    expect(evaluatePredicate({ gte: 2 }, 1)).toBe(false);
    expect(evaluatePredicate({ gte: 2 }, { count: 2 })).toBe(true);
    expect(evaluatePredicate({ gte: 2 }, { count: 1 })).toBe(false);

    expect(evaluatePredicate({ lte: 5 }, 5)).toBe(true);
    expect(evaluatePredicate({ lte: 5 }, 6)).toBe(false);

    expect(evaluatePredicate({ gt: 0 }, 1)).toBe(true);
    expect(evaluatePredicate({ gt: 0 }, 0)).toBe(false);

    expect(evaluatePredicate({ lt: 10 }, 9)).toBe(true);
    expect(evaluatePredicate({ lt: 10 }, 10)).toBe(false);

    expect(evaluatePredicate({ eq: 'active' }, 'active')).toBe(true);
    expect(evaluatePredicate({ eq: 'active' }, 'inactive')).toBe(false);

    expect(evaluatePredicate({ in: ['open', 'in-progress'] }, 'open')).toBe(true);
    expect(evaluatePredicate({ in: ['open', 'in-progress'] }, 'closed')).toBe(false);
  });

  test('evaluates multi-field record predicates', () => {
    const measurement = { count: 4, status: 'ready', score: 0.95 };

    expect(
      evaluatePredicate(
        {
          count: { gte: 1 },
          status: 'ready',
        },
        measurement,
      ),
    ).toBe(true);

    expect(
      evaluatePredicate(
        {
          count: { gte: 10 },
          status: 'ready',
        },
        measurement,
      ),
    ).toBe(false);

    expect(
      evaluatePredicate(
        {
          status: { in: ['ready', 'complete'] },
        },
        measurement,
      ),
    ).toBe(true);
  });
});

describe('formatExpectation and describeClaim', () => {
  test('formats expectations cleanly', () => {
    expect(formatExpectation(true)).toBe('');
    expect(formatExpectation(false)).toBe(' (expect none)');
    expect(formatExpectation({ gte: 2 })).toBe(' (expect >= 2)');
    expect(formatExpectation({ eq: 0 })).toBe(' (expect == 0)');
    expect(formatExpectation({ in: ['a', 'b'] })).toBe(' (expect in [a, b])');
    expect(formatExpectation({ count: { gte: 1 } })).toBe(' (expect count >= 1)');
  });

  test('describes shorthand and structured claims', () => {
    const shorthandTrue: Claim = { kind: 'path', expression: 'src/main.ts', expect: true };
    expect(describeClaim(shorthandTrue)).toBe('path src/main.ts');

    const shorthandFalse: Claim = { kind: 'path', expression: 'src/main.ts', expect: false };
    expect(describeClaim(shorthandFalse)).toBe('path src/main.ts (expect none)');

    const structured: Claim = {
      kind: 'anvesa.callers',
      params: { symbol: 'verify' },
      expect: { gte: 1 },
    };
    expect(describeClaim(structured)).toBe('anvesa.callers symbol=verify (expect >= 1)');
  });

  test('describes composite claims (all, any, not)', () => {
    const allClaim: Claim = {
      kind: 'all',
      claims: [
        { kind: 'path', expression: 'src/a.ts', expect: true },
        { kind: 'path', expression: 'src/b.ts', expect: true },
      ],
      expect: true,
    };
    expect(describeClaim(allClaim)).toBe('all(path src/a.ts, path src/b.ts)');

    const anyClaim: Claim = {
      kind: 'any',
      claims: [
        { kind: 'path', expression: 'src/a.ts', expect: true },
        { kind: 'path', expression: 'src/b.ts', expect: true },
      ],
      expect: false,
    };
    expect(describeClaim(anyClaim)).toBe('any(path src/a.ts, path src/b.ts) (expect none)');

    const notClaim: Claim = {
      kind: 'not',
      claims: [{ kind: 'path', expression: 'src/legacy.ts', expect: true }],
      expect: true,
    };
    expect(describeClaim(notClaim)).toBe('not(path src/legacy.ts)');

    const nested: Claim = {
      kind: 'all',
      claims: [
        { kind: 'path', expression: 'src/a.ts', expect: true },
        {
          kind: 'not',
          claims: [{ kind: 'path', expression: 'src/b.ts', expect: true }],
          expect: true,
        },
      ],
      expect: true,
    };
    expect(describeClaim(nested)).toBe('all(path src/a.ts, not(path src/b.ts))');
  });
});

describe('evaluateClaimOutcome', () => {
  test('preserves unverifiable', () => {
    const claim: Claim = { kind: 'test', expect: true };
    expect(evaluateClaimOutcome(claim, { outcome: 'unverifiable' })).toBe('unverifiable');
    expect(
      evaluateClaimOutcome(claim, { outcome: 'unverifiable', measurements: { count: 5 } }),
    ).toBe('unverifiable');
  });

  test('evaluates predicate when measurements are present', () => {
    const claimGte2: Claim = { kind: 'test', expect: { gte: 2 } };
    expect(evaluateClaimOutcome(claimGte2, { outcome: 'holds', measurements: { count: 3 } })).toBe(
      'holds',
    );
    expect(evaluateClaimOutcome(claimGte2, { outcome: 'holds', measurements: { count: 1 } })).toBe(
      'violated',
    );
  });

  test('falls back to outcome when no measurements are present', () => {
    const claim: Claim = { kind: 'test', expect: true };
    expect(evaluateClaimOutcome(claim, { outcome: 'holds' })).toBe('holds');
    expect(evaluateClaimOutcome(claim, { outcome: 'violated' })).toBe('violated');
  });
});

describe('canonicalClaim', () => {
  test('legacy shorthand format is preserved verbatim', () => {
    const legacy: Claim = { kind: 'path', expression: 'src/index.ts', expect: true };
    expect(canonicalClaim(legacy)).toBe('claim path true src/index.ts');

    const legacyFalse: Claim = { kind: 'path', expression: 'src/index.ts', expect: false };
    expect(canonicalClaim(legacyFalse)).toBe('claim path false src/index.ts');
  });

  test('structured claims hash deterministically with sorted keys', () => {
    const c1: Claim = {
      kind: 'anvesa.callers',
      params: { z: 1, a: 2 },
      expect: { gte: 1 },
    };
    const c2: Claim = {
      kind: 'anvesa.callers',
      params: { a: 2, z: 1 },
      expect: { gte: 1 },
    };
    expect(canonicalClaim(c1)).toBe(canonicalClaim(c2));
  });

  test('composite claims serialize deterministically with child claims', () => {
    const composite: Claim = {
      kind: 'all',
      claims: [
        { kind: 'path', expression: 'src/a.ts', expect: true },
        {
          kind: 'not',
          claims: [{ kind: 'path', expression: 'src/b.ts', expect: true }],
          expect: true,
        },
      ],
      expect: true,
    };
    const s = canonicalClaim(composite);
    expect(s).toBe(
      'claim all claims:[claim path true src/a.ts,claim not claims:[claim path true src/b.ts] expect:true] expect:true',
    );
  });
});
