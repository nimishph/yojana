import { describe, expect, test } from 'bun:test';
import { type WorkLinkPort, YojanaError } from '@cntxt-labs/yojana-core';
import { MarkdownParser } from '@cntxt-labs/yojana-markdown';
import { MemoryBaseStore, MemoryStore } from '@cntxt-labs/yojana-store';
import { openChange } from '../changes.ts';
import { ingest, type PlanFile } from '../ingest.ts';
import { status } from '../status.ts';

const parser = new MarkdownParser();
const DAY = 24 * 60 * 60 * 1000;

const ALPHA = `---
id: plan/alpha
status: accepted
beads: [epic]
---

## Requirement: one {#one}

First.

\`\`\`yojana:claim
kind: path
expression: x
\`\`\`

## Requirement: two {#two}

Second.
`;

const BETA = `---
id: plan/beta
---

## Requirement: only {#only}

Only.
`;

const tracker: WorkLinkPort = {
  name: 'fake',
  get: async (ids) => ({
    ok: true,
    items: ids.map((id) => ({ id, title: id, state: 'open' as const })),
  }),
  children: async () => ({
    ok: true,
    items: [
      { id: 'epic.1', title: 'a', state: 'closed' as const },
      { id: 'epic.2', title: 'b', state: 'open' as const },
    ],
  }),
};

async function setup() {
  let now = 1_000 * DAY;
  const store = new MemoryStore({ now: () => now });
  await store.open();
  const bases = new MemoryBaseStore();
  const files = new Map<string, string>([
    ['plans/alpha.md', ALPHA],
    ['plans/beta.md', BETA],
  ]);
  const planFiles = (): PlanFile[] => [...files].map(([source, text]) => ({ source, text }));
  await ingest({ store, parser, bases, files: planFiles(), actor: 'me' });
  const run = (extra?: { planId?: string }) =>
    status({
      store,
      parser,
      bases,
      files: planFiles(),
      worklink: tracker,
      now,
      staleDays: 14,
      planId: extra?.planId,
    });
  const advance = (days: number) => {
    now += days * DAY;
  };
  return { store, files, run, advance };
}

describe('status', () => {
  test('two plans in step: status, counts, progress from beads, nothing pending', async () => {
    const ctx = await setup();
    const report = await ctx.run();
    expect(report.plans.map((p) => [p.planId, p.status, p.requirements, p.claims])).toEqual([
      ['plan/alpha', 'accepted', 2, 1],
      ['plan/beta', 'draft', 1, 0],
    ]);
    const alpha = report.plans[0];
    expect(alpha?.file).toEqual({
      kind: 'file',
      source: 'plans/alpha.md',
      unrecorded: [],
      behind: [],
      conflicts: [],
      statusUnrecorded: false,
    });
    expect(alpha?.progress).toMatchObject({ done: 1, total: 2 });
    expect(report).toMatchObject({ untracked: [], anomalies: [] });
  });

  test('an open change shows its age, and turns stale after the threshold', async () => {
    const ctx = await setup();
    const parsed = parser.parseChange(
      'changes/c.md',
      '---\nid: tweak\nplan: plan/alpha\n---\n## MODIFIED Requirement: two {#two}\n\nSecond, revised.\n',
    );
    if (!parsed.ok) throw new YojanaError('TEST_FIXTURE', 'change does not parse');
    await openChange({ store: ctx.store, draft: parsed.change, actor: 'me' });

    ctx.advance(3);
    expect((await ctx.run()).plans[0]?.openChanges).toEqual([
      { id: 'tweak', title: 'tweak', ageDays: 3, stale: false },
    ]);
    ctx.advance(20);
    expect((await ctx.run()).plans[0]?.openChanges[0]).toMatchObject({ ageDays: 23, stale: true });
    expect((await ctx.run()).plans[1]?.openChanges).toEqual([]);
  });

  test('an unrecorded edit in a plan file is reported, and status writes nothing', async () => {
    const ctx = await setup();
    ctx.files.set('plans/beta.md', BETA.replace('Only.', 'Only, edited.'));
    const before = await ctx.store.head();
    const report = await ctx.run();
    expect(report.plans[1]?.file).toMatchObject({ unrecorded: ['only'] });
    expect(await ctx.store.head()).toBe(before);
    // Running again still sees it: the dry run did not update the base either.
    expect((await ctx.run()).plans[1]?.file).toMatchObject({ unrecorded: ['only'] });
  });

  test('files that do not parse, or name an unknown plan, are listed as untracked', async () => {
    const ctx = await setup();
    ctx.files.set('plans/broken.md', 'no frontmatter');
    ctx.files.set('plans/new.md', '---\nid: plan/new\n---\n');
    const { untracked } = await ctx.run();
    expect(untracked.map((u) => [u.source, u.planId, u.issues.map((i) => i.code)])).toEqual([
      ['plans/broken.md', undefined, ['MISSING_FRONTMATTER']],
      ['plans/new.md', 'plan/new', []],
    ]);
  });

  test('can be limited to one plan', async () => {
    const ctx = await setup();
    expect((await ctx.run({ planId: 'plan/beta' })).plans.map((p) => p.planId)).toEqual([
      'plan/beta',
    ]);
  });
});
