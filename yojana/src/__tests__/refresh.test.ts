import { describe, expect, test } from 'bun:test';
import { foldLog, planHeads, YojanaError } from '@cntxt-labs/yojana-core';
import { MarkdownParser } from '@cntxt-labs/yojana-markdown';
import { MemoryBaseStore, MemoryStore } from '@cntxt-labs/yojana-store';
import { archiveChange, openChange } from '../changes.ts';
import { ingest, type PlanFile } from '../ingest.ts';
import { refresh } from '../refresh.ts';

const parser = new MarkdownParser();
const SOURCE = 'plans/p.md';
const PLAN = `---
id: plan/p
status: accepted
---

Intro stays.

## Requirement: alpha {#a}

Alpha.

## Requirement: beta {#b}

Beta.

## Requirement: gamma {#c}

Gamma.

## Notes

Notes stay.
`;

async function setup() {
  const store = new MemoryStore();
  await store.open();
  const bases = new MemoryBaseStore();
  const files = new Map([[SOURCE, PLAN]]);
  const planFiles = (): PlanFile[] => [...files].map(([source, text]) => ({ source, text }));
  const write = (source: string, text: string) => files.set(source, text);
  await ingest({ store, parser, bases, files: planFiles(), actor: 'me' });

  /** Archive a change while the plan file has a local edit, so the file is left behind. */
  const archiveWhileDirty = async (body: string, localEdit: (t: string) => string) => {
    const parsed = parser.parseChange('changes/x.md', `---\nid: x\nplan: plan/p\n---\n${body}\n`);
    if (!parsed.ok) throw new YojanaError('TEST_FIXTURE', JSON.stringify(parsed.issues));
    await openChange({ store, draft: parsed.change, actor: 'me' });
    files.set(SOURCE, localEdit(files.get(SOURCE) ?? ''));
    const result = await archiveChange({
      store,
      bases,
      parser,
      changeId: 'x',
      actor: 'me',
      planFiles: planFiles(),
      writePlan: write,
    });
    expect(result.planFile).toMatchObject({ updated: false, reason: 'out-of-step' });
  };
  const run = () => refresh({ store, parser, bases, files: planFiles(), writePlan: write });
  const ingestNow = () => ingest({ store, parser, bases, files: planFiles(), actor: 'me' });
  return { store, files, archiveWhileDirty, run, ingestNow };
}

describe('refresh', () => {
  test('brings behind requirements in, keeps the local edit, and the next ingest records only it', async () => {
    const ctx = await setup();
    await ctx.archiveWhileDirty(
      [
        '## MODIFIED Requirement: alpha {#a}',
        '',
        'Alpha, from the change.',
        '',
        '## REMOVED Requirement: gamma {#c}',
        '',
        '## ADDED Requirement: delta {#d}',
        '',
        'Delta is new.',
      ].join('\n'),
      (t) => t.replace('Beta.', 'Beta, my local edit.'),
    );

    const report = await ctx.run();
    expect(report.files).toEqual([
      {
        source: SOURCE,
        planId: 'plan/p',
        updated: ['a'],
        added: ['d'],
        removed: ['c'],
        status: undefined,
      },
    ]);
    const text = ctx.files.get(SOURCE) ?? '';
    expect(text).toContain('Alpha, from the change.');
    expect(text).toContain('Delta is new.');
    expect(text).not.toContain('Gamma.');
    expect(text).toContain('Beta, my local edit.');
    expect(text).toContain('Intro stays.');
    expect(text).toContain('Notes stay.');

    // Nothing is behind any more; the local edit is still an edit and gets recorded.
    const after = await ctx.ingestNow();
    expect(after.files[0]?.requirements.map((r) => [r.id, r.movement])).toEqual([['b', 'edited']]);
    const heads = planHeads(foldLog(await ctx.store.events()), 'plan/p');
    expect([...heads.keys()].sort()).toEqual(['a', 'b', 'd']);
    expect((await ctx.ingestNow()).files[0]?.requirements).toEqual([]);
  });

  test('a file that is not behind is left untouched', async () => {
    const ctx = await setup();
    expect((await ctx.run()).files).toEqual([]);
    expect(ctx.files.get(SOURCE)).toBe(PLAN);
  });
});
