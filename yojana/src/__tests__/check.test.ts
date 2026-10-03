import { describe, expect, test } from 'bun:test';
import type { VerifierPort } from '@cntxt-labs/yojana-core';
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
    const found = claim.expression.startsWith('present');
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
});
