import { describe, expect, test } from 'bun:test';
import { foldLog, planHeads, YojanaError } from '@cntxt-labs/yojana-core';
import { MarkdownParser } from '@cntxt-labs/yojana-markdown';
import { MemoryBaseStore, MemoryStore } from '@cntxt-labs/yojana-store';
import { archiveChange } from '../changes.ts';
import { editRequirement, suggestEdit } from '../edit.ts';
import { ingest, type PlanFile } from '../ingest.ts';

const parser = new MarkdownParser();
const SOURCE = 'plans/p.md';
const PLAN = `---
id: plan/p
status: accepted
---

Intro.

## Requirement: alpha {#a beads=x-1}

Alpha as planned.

\`\`\`yojana:claim
kind: path
expression: a.txt
\`\`\`

## Requirement: beta {#b}

Beta.
`;

async function setup() {
  const store = new MemoryStore();
  await store.open();
  const bases = new MemoryBaseStore();
  const files = new Map<string, string>([[SOURCE, PLAN]]);
  const planFiles = (): PlanFile[] =>
    [...files].filter(([s]) => s.startsWith('plans/')).map(([source, text]) => ({ source, text }));
  await ingest({ store, parser, bases, files: planFiles(), actor: 'me' });
  const head = async (id: string) => {
    const r = foldLog(await store.events())
      .plans.get('plan/p')
      ?.heads.get(id);
    if (r === undefined) throw new YojanaError('TEST_FIXTURE', `no ${id}`);
    return r;
  };
  const edit = async (fields: { id?: string; revision?: string; title?: string; text: string }) => {
    const r = await head(fields.id ?? 'a');
    return editRequirement({
      store,
      parser,
      bases,
      files: planFiles(),
      planId: 'plan/p',
      requirementId: r.id,
      expectedRevision: fields.revision ?? r.revision,
      title: fields.title ?? r.title,
      text: fields.text,
      actor: 'me',
      writePlan: (s, t) => files.set(s, t),
    });
  };
  const suggest = async (fields: { revision?: string; text: string; why?: string }) => {
    const r = await head('a');
    return suggestEdit({
      store,
      parser,
      planId: 'plan/p',
      requirementId: 'a',
      expectedRevision: fields.revision ?? r.revision,
      title: r.title,
      text: fields.text,
      why: fields.why ?? '',
      actor: 'reviewer',
      changesDir: 'changes',
      writeChange: (s, t) => files.set(s, t),
    });
  };
  return { store, bases, files, planFiles, head, edit, suggest };
}

describe('editRequirement', () => {
  test('rewrites the requirement in the file and records it; claims, links and prose stay', async () => {
    const ctx = await setup();
    const before = await ctx.head('a');
    const result = await ctx.edit({ text: 'Alpha, edited on the page.' });
    expect(result.ok).toBe(true);
    const after = await ctx.head('a');
    expect(after.revision).not.toBe(before.revision);
    expect(after.claims).toEqual(before.claims);
    expect(after.workItems).toEqual(['x-1']);
    const text = ctx.files.get(SOURCE) ?? '';
    expect(text).toContain('Alpha, edited on the page.');
    expect(text).toContain('Intro.');
    expect(text).toContain('{#a beads=x-1}');
    // File, base and log agree: nothing left to ingest.
    const again = await ingest({
      store: ctx.store,
      parser,
      bases: ctx.bases,
      files: ctx.planFiles(),
      actor: 'me',
    });
    expect(again.files[0]?.requirements).toEqual([]);
  });

  test('a stale revision is refused with the current text', async () => {
    const ctx = await setup();
    const shown = (await ctx.head('a')).revision;
    await ctx.edit({ text: 'Someone else got here first.' });
    const late = await ctx.edit({ revision: shown, text: 'My edit.' });
    expect(late).toMatchObject({
      ok: false,
      code: 'STALE',
      current: { text: 'Someone else got here first.' },
    });
  });

  test('refuses when the file has edits not ingested, and text that would reshape the plan', async () => {
    const ctx = await setup();
    ctx.files.set(SOURCE, PLAN.replace('Beta.', 'Beta, edited in an editor.'));
    expect(await ctx.edit({ text: 'Page edit.' })).toMatchObject({ code: 'FILE_NOT_IN_STEP' });

    const clean = await setup();
    expect(
      await clean.edit({ text: 'Fine.\n\n## Requirement: sneaky {#c}\n\nNew.' }),
    ).toMatchObject({
      code: 'INVALID_TEXT',
    });
    expect(await clean.edit({ text: 'Alpha as planned.' })).toMatchObject({ code: 'UNCHANGED' });
    expect(clean.files.get(SOURCE)).toBe(PLAN);
  });
});

describe('suggestEdit', () => {
  test('writes and opens a change pinned to the shown revision; archiving applies it', async () => {
    const ctx = await setup();
    const shown = (await ctx.head('a')).revision;
    const result = await ctx.suggest({ text: 'Alpha, as suggested.', why: 'Clearer.' });
    if (!result.ok) throw new YojanaError('TEST_FIXTURE', result.message);
    const changeText = ctx.files.get(result.source) ?? '';
    expect(changeText).toContain('## MODIFIED Requirement: alpha {#a beads=x-1}');
    expect(changeText).toContain('Clearer.');
    expect(changeText).toContain('kind: path');
    const state = foldLog(await ctx.store.events());
    expect(state.changes.get(result.changeId)?.change.deltas[0]).toMatchObject({ base: shown });

    const archived = await archiveChange({
      store: ctx.store,
      bases: ctx.bases,
      parser,
      changeId: result.changeId,
      actor: 'me',
      planFiles: ctx.planFiles(),
      writePlan: (s, t) => ctx.files.set(s, t),
    });
    expect(archived.outcome).toBe('archived');
    expect(ctx.files.get(SOURCE)).toContain('Alpha, as suggested.');
    expect(planHeads(foldLog(await ctx.store.events()), 'plan/p').get('a')).not.toBe(shown);
  });

  test('a suggestion on a stale revision is refused, and nothing is written', async () => {
    const ctx = await setup();
    const shown = (await ctx.head('a')).revision;
    await ctx.edit({ text: 'Moved on.' });
    const before = ctx.files.size;
    expect(await ctx.suggest({ revision: shown, text: 'Old idea.' })).toMatchObject({
      code: 'STALE',
    });
    expect(ctx.files.size).toBe(before);
  });
});
