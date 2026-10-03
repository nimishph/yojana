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
});
