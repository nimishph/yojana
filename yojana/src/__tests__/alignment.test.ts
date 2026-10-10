import { describe, expect, test } from 'bun:test';
import {
  type VerifierPort,
  type WorkItem,
  type WorkLinkPort,
  YojanaError,
} from '@cntxt-labs/yojana-core';
import { MarkdownParser } from '@cntxt-labs/yojana-markdown';
import { MemoryBaseStore, MemoryStore } from '@cntxt-labs/yojana-store';
import { check } from '../check.ts';
import { ingest } from '../ingest.ts';
import { status } from '../status.ts';

const parser = new MarkdownParser();

const PLAN = `---
id: plan/p
---

## Requirement: done but open {#done-open beads=b-open}

\`\`\`yojana:claim
kind: fake
expression: present
\`\`\`

## Requirement: closed but broken {#closed-broken beads=b-closed}

\`\`\`yojana:claim
kind: fake
expression: absent
\`\`\`

## Requirement: in step {#in-step beads=b-closed}

\`\`\`yojana:claim
kind: fake
expression: present
\`\`\`

## Requirement: unlinked {#unlinked}

\`\`\`yojana:claim
kind: fake
expression: present
\`\`\`
`;

const fake: VerifierPort = {
  name: 'fake',
  kinds: ['fake'],
  async verify(requirement, claim) {
    const found = claim.expression === 'present';
    return {
      requirement,
      claim,
      outcome: found === claim.expect ? 'holds' : 'violated',
      evidence: '',
    };
  },
};

const states: Record<string, WorkItem['state']> = { 'b-open': 'open', 'b-closed': 'closed' };
const tracker: WorkLinkPort = {
  name: 'fake',
  get: async (ids) => ({
    ok: true,
    items: ids.map((id) => ({ id, title: id, state: states[id] ?? ('missing' as const) })),
  }),
  children: async () => ({ ok: true, items: [] }),
};

describe('requirement links', () => {
  test('parse from the heading, round-trip, and change the revision only when present', () => {
    const parsed = parser.parse('p.md', PLAN);
    if (!parsed.ok) throw new YojanaError('TEST_FIXTURE', JSON.stringify(parsed.issues));
    const [first, , , unlinked] = parsed.plan.requirements;
    expect(first?.workItems).toEqual(['b-open']);
    expect(unlinked?.workItems).toBeUndefined();
    const again = parser.parse('p.md', parser.render(parsed.plan));
    expect(again.ok && again.plan.requirements).toEqual(parsed.plan.requirements);

    const relinked = parser.parse('p.md', PLAN.replace('beads=b-open', 'beads=b-open,b-2'));
    expect(relinked.ok && relinked.plan.requirements[0]?.revision).not.toBe(first?.revision);
  });

  test('an unknown attribute is an issue', () => {
    const result = parser.parse('p.md', PLAN.replace('beads=b-open', 'owner=me'));
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toEqual([
      'INVALID_REQUIREMENT_ATTRIBUTE',
    ]);
  });
});

describe('status alignment', () => {
  test('flags claims-hold-but-open and closed-but-violated, and nothing else', async () => {
    const store = new MemoryStore();
    await store.open();
    const bases = new MemoryBaseStore();
    const files = [{ source: 'plans/p.md', text: PLAN }];
    await ingest({ store, parser, bases, files, actor: 'me' });
    const checks = await check({ store, verifiers: [fake] });
    const report = await status({
      store,
      parser,
      bases,
      files,
      worklink: tracker,
      checks,
      now: 0,
      staleDays: 14,
    });
    expect(report.plans[0]?.alignment.map((a) => [a.requirement, a.mismatch])).toEqual([
      ['done-open', 'claims-hold-work-open'],
      ['closed-broken', 'work-closed-claims-violated'],
      ['in-step', undefined],
    ]);
  });

  test('without claim results there is nothing to align', async () => {
    const store = new MemoryStore();
    await store.open();
    const bases = new MemoryBaseStore();
    const files = [{ source: 'plans/p.md', text: PLAN }];
    await ingest({ store, parser, bases, files, actor: 'me' });
    const report = await status({
      store,
      parser,
      bases,
      files,
      worklink: tracker,
      now: 0,
      staleDays: 14,
    });
    expect(report.plans[0]?.alignment).toEqual([]);
  });

  test('derives action state and flags close? and reopen? per action', async () => {
    const PLAN_ACTIONS = `---
id: plan/act
---

## Requirement: with actions {#req-with-actions}

### Actions
- Hold but open {#act-hold-open bead=b-open}
\`\`\`yojana:claim
kind: fake
expression: present
\`\`\`
- Closed but broken {#act-closed-violated bead=b-closed}
\`\`\`yojana:claim
kind: fake
expression: absent
\`\`\`
- In step {#act-in-step bead=b-closed}
\`\`\`yojana:claim
kind: fake
expression: present
\`\`\`
- Bead only closed {#act-bead-closed bead=b-closed}
- Bead only open {#act-bead-open bead=b-open}
- Claim only holds {#act-claim-holds}
\`\`\`yojana:claim
kind: fake
expression: present
\`\`\`
- Claim only violated {#act-claim-violated}
\`\`\`yojana:claim
kind: fake
expression: absent
\`\`\`
- Neither {#act-neither}
`;
    const store = new MemoryStore();
    await store.open();
    const bases = new MemoryBaseStore();
    const files = [{ source: 'plans/act.md', text: PLAN_ACTIONS }];
    await ingest({ store, parser, bases, files, actor: 'me' });
    const checks = await check({ store, verifiers: [fake] });
    const report = await status({
      store,
      parser,
      bases,
      files,
      worklink: tracker,
      checks,
      now: 0,
      staleDays: 14,
    });
    const reqAlign = report.plans[0]?.alignment[0];
    expect(reqAlign?.requirement).toBe('req-with-actions');
    expect(reqAlign?.mismatch).toBeUndefined(); // Requirement itself has no beads/claims
    const actions = reqAlign?.actions ?? [];
    expect(actions.map((a) => [a.action, a.done, a.mismatch])).toEqual([
      ['act-hold-open', false, 'claims-hold-work-open'],
      ['act-closed-violated', false, 'work-closed-claims-violated'],
      ['act-in-step', true, undefined],
      ['act-bead-closed', true, undefined],
      ['act-bead-open', false, undefined],
      ['act-claim-holds', true, undefined],
      ['act-claim-violated', false, undefined],
      ['act-neither', false, undefined],
    ]);
  });

  test('non-deterministic claims do not drive close? or reopen? mismatches', async () => {
    const nonDetVerifier: VerifierPort = {
      name: 'non-det-adapter',
      kinds: ['non-det'],
      describe: () => ({
        name: 'non-det-adapter',
        kinds: [
          {
            kind: 'non-det',
            expression: true,
            deterministic: false,
          },
        ],
      }),
      verify: async (req, claim) => ({
        requirement: req,
        claim,
        outcome: claim.expression === 'holds' ? 'holds' : 'violated',
        evidence: 'measured',
        deterministic: false,
        measuredAt: Date.now(),
      }),
    };

    const PLAN_NONDET = `---
id: plan/nondet
---

## Requirement: open with non-det holds {#open-nondet beads=b-open}

\`\`\`yojana:claim
kind: non-det
expression: holds
\`\`\`

## Requirement: closed with non-det violated {#closed-nondet beads=b-closed}

\`\`\`yojana:claim
kind: non-det
expression: violated
\`\`\`
`;

    const store = new MemoryStore();
    await store.open();
    const bases = new MemoryBaseStore();
    const files = [{ source: 'plans/nondet.md', text: PLAN_NONDET }];
    await ingest({ store, parser, bases, files, actor: 'me' });
    const checks = await check({ store, verifiers: [nonDetVerifier] });
    const report = await status({
      store,
      parser,
      bases,
      files,
      worklink: tracker,
      checks,
      now: 0,
      staleDays: 14,
    });
    // Non-deterministic claims should NOT drive claims-hold-work-open or work-closed-claims-violated
    expect(report.plans[0]?.alignment.map((a) => [a.requirement, a.mismatch])).toEqual([
      ['open-nondet', undefined],
      ['closed-nondet', undefined],
    ]);
  });
});
