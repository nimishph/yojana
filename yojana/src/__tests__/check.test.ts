import { describe, expect, test } from 'bun:test';
import type { ClaimCachePort, ClaimResult, VerifierPort } from '@cntxt-labs/yojana-core';
import { MarkdownParser } from '@cntxt-labs/yojana-markdown';
import { MemoryBaseStore, MemoryStore } from '@cntxt-labs/yojana-store';
import { check } from '../check.ts';
import { ingest } from '../ingest.ts';

const PLAN = `---
id: plan/p
---

## Requirement: has a manifest {#a}

\`\`\`yojana:claim
kind: fake
expression: present
\`\`\`

## Requirement: no loops {#b}

\`\`\`yojana:claim
kind: fake
expression: absent
expect: false
\`\`\`

\`\`\`yojana:claim
kind: mystery
expression: anything
\`\`\`
`;

/** Says "found" for expressions starting with "present". */
const fake: VerifierPort = {
  name: 'fake',
  kinds: ['fake'],
  async verify(requirement, claim) {
    const found = (claim.expression ?? '').startsWith('present');
    return {
      requirement,
      claim,
      outcome: found === claim.expect ? 'holds' : 'violated',
      evidence: found ? 'found' : 'not found',
    };
  },
};

async function setup(text: string) {
  const store = new MemoryStore();
  await store.open();
  await ingest({
    store,
    parser: new MarkdownParser(),
    bases: new MemoryBaseStore(),
    files: [{ source: 'plans/p.md', text }],
    actor: 'me',
  });
  return store;
}

describe('check', () => {
  test('runs every claim of the plan in the log and counts outcomes', async () => {
    const report = await check({ store: await setup(PLAN), verifiers: [fake] });
    expect(report.plans.map((p) => p.planId)).toEqual(['plan/p']);
    expect(report.plans[0]?.results.map((r) => [r.requirement, r.claim.kind, r.outcome])).toEqual([
      ['a', 'fake', 'holds'],
      ['b', 'fake', 'holds'],
      ['b', 'mystery', 'unverifiable'],
    ]);
    expect(report).toMatchObject({ holds: 2, violated: 0, unverifiable: 1 });
    expect(report.plans[0]?.results[2]?.evidence).toBe(
      'no verifier for kind "mystery"; known kinds: fake',
    );
  });

  test('a claim the code breaks is violated', async () => {
    const broken = PLAN.replace('expression: absent', 'expression: present-but-should-not-be');
    const report = await check({ store: await setup(broken), verifiers: [fake] });
    expect(report.violated).toBe(1);
  });

  test('can be limited to one plan', async () => {
    const store = await setup(PLAN);
    expect((await check({ store, verifiers: [fake], planId: 'plan/other' })).plans).toEqual([]);
  });

  test('a claim with params and a count predicate holds and violates correctly', async () => {
    const structuredPlan = `---
id: plan/metrics
---

## Requirement: metrics check {#req-metrics}

\`\`\`yojana:claim
kind: count-verifier
target: users
expect:
  gte: 5
\`\`\`

\`\`\`yojana:claim
kind: count-verifier
target: errors
expect:
  lte: 0
\`\`\`
`;

    const countVerifier: VerifierPort = {
      name: 'counter',
      kinds: ['count-verifier'],
      async verify(requirement, claim) {
        const target = claim.params?.target;
        const count = target === 'users' ? 10 : 2;
        return {
          requirement,
          claim,
          outcome: 'holds',
          measurements: { count },
          evidence: `${count} items for ${String(target)}`,
        };
      },
    };

    const report = await check({ store: await setup(structuredPlan), verifiers: [countVerifier] });
    expect(report.holds).toBe(1);
    expect(report.violated).toBe(1);
    expect(report.plans[0]?.results[0]?.outcome).toBe('holds');
    expect(report.plans[0]?.results[1]?.outcome).toBe('violated');
  });

  test('deterministic and measuredAt flags are set according to descriptor', async () => {
    const mixedPlan = `---
id: plan/mixed
---

## Requirement: deterministic req {#req-det}

\`\`\`yojana:claim
kind: det-kind
expression: test
\`\`\`

## Requirement: non-deterministic req {#req-nondet}

\`\`\`yojana:claim
kind: nondet-kind
expression: test
\`\`\`
`;

    const mixedVerifier: VerifierPort = {
      name: 'mixed-adapter',
      kinds: ['det-kind', 'nondet-kind'],
      describe: () => ({
        name: 'mixed-adapter',
        kinds: [
          { kind: 'det-kind', expression: true, deterministic: true },
          { kind: 'nondet-kind', expression: true, deterministic: false },
        ],
      }),
      verify: async (req, claim) => ({
        requirement: req,
        claim,
        outcome: 'holds',
        evidence: 'checked',
      }),
    };

    const report = await check({ store: await setup(mixedPlan), verifiers: [mixedVerifier] });
    const results = report.plans[0]?.results ?? [];
    expect(results).toHaveLength(2);
    expect(results[0]?.deterministic).toBe(true);
    expect(results[0]?.measuredAt).toBeUndefined();
    expect(results[1]?.deterministic).toBe(false);
    expect(typeof results[1]?.measuredAt).toBe('number');
  });

  test('claim cache: deterministic claims are cached; non-deterministic are not', async () => {
    let indexStateVal = 'git-commit-1';
    let verifyCallCount = 0;

    const cachingVerifier: VerifierPort = {
      name: 'cacheable-adapter',
      kinds: ['cacheable-det', 'live-nondet'],
      describe: () => ({
        name: 'cacheable-adapter',
        version: '1.0.0',
        kinds: [
          { kind: 'cacheable-det', expression: true, deterministic: true, version: '1.0.0' },
          { kind: 'live-nondet', expression: true, deterministic: false },
        ],
      }),
      indexState: () => indexStateVal,
      verify: async (req, claim) => {
        verifyCallCount++;
        return {
          requirement: req,
          claim,
          outcome: 'holds',
          evidence: `verified at count ${verifyCallCount}`,
        };
      },
    };

    const cacheStore = new Map<string, ClaimResult>();
    const cache: ClaimCachePort = {
      get: (k) => cacheStore.get(k),
      set: (k, v) => {
        cacheStore.set(k, v);
      },
    };

    const testPlan = `---
id: plan/caching
---

## Requirement: det req {#req-c-det}

\`\`\`yojana:claim
kind: cacheable-det
expression: value
\`\`\`

## Requirement: nondet req {#req-c-nondet}

\`\`\`yojana:claim
kind: live-nondet
expression: value
\`\`\`
`;

    const store = await setup(testPlan);

    // Pass 1: both claims run verify()
    const report1 = await check({ store, verifiers: [cachingVerifier], cache });
    expect(report1.holds).toBe(2);
    expect(verifyCallCount).toBe(2);
    expect(cacheStore.size).toBe(1); // Only deterministic claim was cached

    // Pass 2: deterministic claim hits cache; non-deterministic runs verify() again
    const report2 = await check({ store, verifiers: [cachingVerifier], cache });
    expect(verifyCallCount).toBe(3); // 2 + 1 (only live-nondet called verify)
    expect(report2.plans[0]?.results[0]?.evidence).toBe('verified at count 1'); // Reused cached result

    // Pass 3: indexState changes -> cache key changes -> deterministic claim runs verify() again
    indexStateVal = 'git-commit-2';
    const report3 = await check({ store, verifiers: [cachingVerifier], cache });
    expect(report3.holds).toBe(2);
    expect(verifyCallCount).toBe(5); // Both ran verify again
    expect(cacheStore.size).toBe(2); // Two entries for the two index states
  });

  test('composite claims: all, any, not evaluation', async () => {
    const compositePlan = `---
id: plan/composite
---

## Requirement: all pass {#req-all-pass}

\`\`\`yojana:claim
kind: all
claims:
  - kind: fake
    expression: present-1
  - kind: fake
    expression: present-2
\`\`\`

## Requirement: all fail {#req-all-fail}

\`\`\`yojana:claim
kind: all
claims:
  - kind: fake
    expression: present-1
  - kind: fake
    expression: absent-1
\`\`\`

## Requirement: any pass {#req-any-pass}

\`\`\`yojana:claim
kind: any
claims:
  - kind: fake
    expression: absent-1
  - kind: fake
    expression: present-1
\`\`\`

## Requirement: any fail {#req-any-fail}

\`\`\`yojana:claim
kind: any
claims:
  - kind: fake
    expression: absent-1
  - kind: fake
    expression: absent-2
\`\`\`

## Requirement: not holds {#req-not-holds}

\`\`\`yojana:claim
kind: not
claim:
  kind: fake
  expression: absent-legacy
\`\`\`

## Requirement: not violated {#req-not-violated}

\`\`\`yojana:claim
kind: not
claim:
  kind: fake
  expression: present-legacy
\`\`\`

## Requirement: A and not B {#req-a-and-not-b}

\`\`\`yojana:claim
kind: all
claims:
  - kind: fake
    expression: present-new
  - kind: not
    claim:
      kind: fake
      expression: absent-deprecated
\`\`\`
`;

    const store = await setup(compositePlan);
    const report = await check({ store, verifiers: [fake] });

    expect(report.plans[0]?.results).toHaveLength(7);
    const results = report.plans[0]?.results ?? [];

    // all pass
    expect(results[0]?.outcome).toBe('holds');
    expect(results[0]?.evidence).toContain('all 2 claims hold');

    // all fail
    expect(results[1]?.outcome).toBe('violated');
    expect(results[1]?.evidence).toContain('1 of 2 claims not holding');

    // any pass
    expect(results[2]?.outcome).toBe('holds');
    expect(results[2]?.evidence).toContain('1 of 2 claims hold');

    // any fail
    expect(results[3]?.outcome).toBe('violated');
    expect(results[3]?.evidence).toContain('all 2 claims violated');

    // not holds (absent child is violated, so not is holds)
    expect(results[4]?.outcome).toBe('holds');

    // not violated (present child holds, so not is violated)
    expect(results[5]?.outcome).toBe('violated');

    // A and not B (present-new holds, absent-deprecated is false so not holds -> all holds)
    expect(results[6]?.outcome).toBe('holds');
  });

  test('composite claims: three-valued logic with unverifiable child', async () => {
    const unvPlan = `---
id: plan/unv
---

## Requirement: all with unv and hold {#req-all-unv}

\`\`\`yojana:claim
kind: all
claims:
  - kind: fake
    expression: present-1
  - kind: mystery
    expression: unv
\`\`\`

## Requirement: all with unv and violated {#req-all-violated-unv}

\`\`\`yojana:claim
kind: all
claims:
  - kind: fake
    expression: absent-1
  - kind: mystery
    expression: unv
\`\`\`

## Requirement: any with unv and hold {#req-any-hold-unv}

\`\`\`yojana:claim
kind: any
claims:
  - kind: fake
    expression: present-1
  - kind: mystery
    expression: unv
\`\`\`

## Requirement: any with unv and violated {#req-any-unv}

\`\`\`yojana:claim
kind: any
claims:
  - kind: fake
    expression: absent-1
  - kind: mystery
    expression: unv
\`\`\`
`;

    const store = await setup(unvPlan);
    const report = await check({ store, verifiers: [fake] });
    const results = report.plans[0]?.results ?? [];

    // all: true AND unv = unv
    expect(results[0]?.outcome).toBe('unverifiable');

    // all: false AND unv = false (violated)
    expect(results[1]?.outcome).toBe('violated');

    // any: true OR unv = true (holds)
    expect(results[2]?.outcome).toBe('holds');

    // any: false OR unv = unv
    expect(results[3]?.outcome).toBe('unverifiable');
  });
});
