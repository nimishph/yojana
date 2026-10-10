import { describe, expect, test } from 'bun:test';
import { foldLog, planHeads, YojanaError } from '@cntxt-labs/yojana-core';
import { MarkdownParser } from '@cntxt-labs/yojana-markdown';
import { MemoryBaseStore, MemoryStore } from '@cntxt-labs/yojana-store';
import { abandonChange, archiveChange, openChange } from '../changes.ts';
import { ingest, type PlanFile } from '../ingest.ts';

const parser = new MarkdownParser();
const PLAN_SOURCE = 'plans/p.md';

const PLAN = `---
id: plan/p
status: accepted
---

Context that must survive an archive.

## Requirement: alpha {#a}

Alpha as planned.

## Requirement: beta {#b}

Beta as planned.

## Notes

Trailing notes stay too.
`;

function changeText(id: string, body: string): string {
  return `---\nid: ${id}\nplan: plan/p\ntitle: ${id}\n---\n\nWhy ${id}.\n\n${body}\n`;
}

function draft(id: string, body: string) {
  const parsed = parser.parseChange(`changes/${id}.md`, changeText(id, body));
  if (!parsed.ok) throw new YojanaError('TEST_FIXTURE', JSON.stringify(parsed.issues));
  return parsed.change;
}

async function setup() {
  const store = new MemoryStore();
  await store.open();
  const bases = new MemoryBaseStore();
  const files = new Map<string, string>([[PLAN_SOURCE, PLAN]]);
  const planFiles = (): PlanFile[] => [...files].map(([source, text]) => ({ source, text }));
  await ingest({ store, parser, bases, files: planFiles(), actor: 'me' });

  const open = (id: string, body: string) =>
    openChange({ store, draft: draft(id, body), actor: 'me' });
  const archive = (changeId: string) =>
    archiveChange({
      store,
      bases,
      parser,
      changeId,
      actor: 'me',
      planFiles: planFiles(),
      writePlan: (source, text) => files.set(source, text),
    });
  const ingestFiles = () => ingest({ store, parser, bases, files: planFiles(), actor: 'me' });
  const state = async () => foldLog(await store.events());
  return { store, bases, files, open, archive, ingestFiles, state };
}

describe('openChange', () => {
  test('pins MODIFIED and REMOVED to the current log revisions', async () => {
    const ctx = await setup();
    const heads = planHeads(await ctx.state(), 'plan/p');
    const result = await ctx.open(
      'tweak',
      '## MODIFIED Requirement: alpha {#a}\n\nAlpha, revised.\n\n## REMOVED Requirement: beta {#b}',
    );
    expect(result.outcome).toBe('opened');
    expect(result.change?.deltas).toMatchObject([
      { op: 'modify', base: heads.get('a') },
      { op: 'remove', id: 'b', base: heads.get('b') },
    ]);
    expect((await ctx.state()).changes.get('tweak')?.status).toBe('open');
  });

  test('refuses edits that cannot apply, and records nothing', async () => {
    const ctx = await setup();
    const before = await ctx.store.head();
    const result = await ctx.open(
      'bad',
      [
        '## ADDED Requirement: alpha {#a}',
        'dup',
        '## MODIFIED Requirement: gamma {#c}',
        'missing',
        '## MODIFIED Requirement: beta {#b}',
        '',
        'Beta as planned.',
      ].join('\n'),
    );
    expect(result.outcome).toBe('refused');
    expect(result.problems.map((p) => [p.requirement, p.code])).toEqual([
      ['a', 'ALREADY_EXISTS'],
      ['c', 'NOT_FOUND'],
      ['b', 'UNCHANGED'],
    ]);
    expect(await ctx.store.head()).toBe(before);
  });

  test('refuses a reused change id and an unknown plan', async () => {
    const ctx = await setup();
    await ctx.open('once', '## ADDED Requirement: gamma {#c}\nnew');
    const again = await ctx.open('once', '## ADDED Requirement: delta {#d}\nnew');
    expect(again.problems.map((p) => p.code)).toEqual(['CHANGE_EXISTS']);

    const parsed = parser.parseChange(
      'x.md',
      '---\nid: elsewhere\nplan: plan/none\n---\n## ADDED Requirement: a {#a}\n',
    );
    if (!parsed.ok) throw new YojanaError('TEST_FIXTURE', 'does not parse');
    const unknown = await openChange({ store: ctx.store, draft: parsed.change, actor: 'me' });
    expect(unknown.problems.map((p) => p.code)).toEqual(['PLAN_NOT_FOUND']);
  });

  test('allows changing actions when requirement text is unchanged', async () => {
    const ctx = await setup();
    const resAdd = await ctx.open(
      'add-acts',
      [
        '## MODIFIED Requirement: alpha {#a}',
        '',
        'Alpha as planned.',
        '',
        '### Actions',
        '- [ ] First step {#act-1 bead=b-1}',
      ].join('\n'),
    );
    expect(resAdd.outcome).toBe('opened');

    const resSame = await ctx.open(
      'same-acts',
      ['## MODIFIED Requirement: alpha {#a}', '', 'Alpha as planned.'].join('\n'),
    );
    expect(resSame.outcome).toBe('refused');
    expect(resSame.problems[0]?.code).toBe('UNCHANGED');
  });
});

describe('archiveChange', () => {
  test('applies the change to the log and rewrites an in-step plan file, keeping its prose', async () => {
    const ctx = await setup();
    await ctx.open(
      'tweak',
      [
        '## MODIFIED Requirement: alpha {#a}',
        '',
        'Alpha, revised.',
        '',
        '## REMOVED Requirement: beta {#b}',
        '',
        '## ADDED Requirement: gamma {#c}',
        '',
        'Gamma is new.',
      ].join('\n'),
    );
    const result = await ctx.archive('tweak');
    expect(result).toMatchObject({
      outcome: 'archived',
      planFile: { updated: true, source: PLAN_SOURCE },
    });

    const state = await ctx.state();
    expect(state.changes.get('tweak')?.status).toBe('archived');
    expect([...planHeads(state, 'plan/p').keys()]).toEqual(['a', 'c']);

    const text = ctx.files.get(PLAN_SOURCE) ?? '';
    expect(text).toContain('Context that must survive an archive.');
    expect(text).toContain('Trailing notes stay too.');
    expect(text).toContain('Alpha, revised.');
    expect(text).not.toContain('Beta as planned.');
    // Added after the last requirement, ahead of trailing prose.
    expect(text.indexOf('Gamma is new.')).toBeLessThan(text.indexOf('## Notes'));
    expect(text.indexOf('Gamma is new.')).toBeGreaterThan(text.indexOf('Alpha, revised.'));

    // File, base and log agree afterwards: ingest finds nothing to do.
    const after = await ctx.ingestFiles();
    expect(after.files[0]).toMatchObject({ outcome: 'unchanged', requirements: [] });
  });

  test('two changes to one requirement: the first archives, the second is refused by name', async () => {
    const ctx = await setup();
    await ctx.open('first', '## MODIFIED Requirement: alpha {#a}\n\nAlpha, first take.');
    await ctx.open('second', '## MODIFIED Requirement: alpha {#a}\n\nAlpha, second take.');
    const pinned = planHeads(await ctx.state(), 'plan/p').get('a');

    expect((await ctx.archive('first')).outcome).toBe('archived');
    const now = planHeads(await ctx.state(), 'plan/p').get('a');
    const before = await ctx.store.head();

    const second = await ctx.archive('second');
    expect(second.outcome).toBe('refused');
    expect(second.conflicts).toEqual([
      { requirement: 'a', op: 'modify', expected: pinned, actual: now },
    ]);
    expect(await ctx.store.head()).toBe(before);
    expect((await ctx.state()).changes.get('second')?.status).toBe('open');
  });

  test('changes to different requirements both archive', async () => {
    const ctx = await setup();
    await ctx.open('one', '## MODIFIED Requirement: alpha {#a}\n\nAlpha 2.');
    await ctx.open('two', '## MODIFIED Requirement: beta {#b}\n\nBeta 2.');
    expect((await ctx.archive('one')).outcome).toBe('archived');
    expect((await ctx.archive('two')).outcome).toBe('archived');
    const text = ctx.files.get(PLAN_SOURCE) ?? '';
    expect(text).toContain('Alpha 2.');
    expect(text).toContain('Beta 2.');
  });

  test('a plan file with unrecorded edits is left alone and reported', async () => {
    const ctx = await setup();
    await ctx.open('tweak', '## MODIFIED Requirement: alpha {#a}\n\nAlpha, revised.');
    const edited = PLAN.replace('Beta as planned.', 'Beta, my local edit.');
    ctx.files.set(PLAN_SOURCE, edited);

    const result = await ctx.archive('tweak');
    expect(result).toMatchObject({
      outcome: 'archived',
      planFile: { updated: false, source: PLAN_SOURCE, reason: 'out-of-step' },
    });
    expect(ctx.files.get(PLAN_SOURCE)).toBe(edited);
  });

  test('a closed or unknown change cannot be archived', async () => {
    const ctx = await setup();
    await ctx.open('tweak', '## MODIFIED Requirement: alpha {#a}\n\nAlpha, revised.');
    await ctx.archive('tweak');
    expect((await ctx.archive('tweak')).problems.map((p) => p.code)).toEqual(['CHANGE_NOT_OPEN']);
    expect((await ctx.archive('nope')).problems.map((p) => p.code)).toEqual(['CHANGE_NOT_FOUND']);
  });

  test('applies changes that add, edit, or remove actions under requirements', async () => {
    const ctx = await setup();
    // 1. Add actions to requirement a
    await ctx.open(
      'add-act',
      [
        '## MODIFIED Requirement: alpha {#a}',
        '',
        'Alpha as planned.',
        '',
        '### Actions',
        '- [ ] Action 1 {#act-1 bead=b-1}',
      ].join('\n'),
    );
    const arch1 = await ctx.archive('add-act');
    expect(arch1.outcome).toBe('archived');
    expect(arch1.planFile?.updated).toBe(true);

    let state = await ctx.state();
    let headA = state.plans.get('plan/p')?.heads.get('a');
    expect(headA?.actions).toHaveLength(1);
    expect(headA?.actions?.[0]?.id).toBe('act-1');
    expect(headA?.actions?.[0]?.workItems).toEqual(['b-1']);
    expect(ctx.files.get(PLAN_SOURCE)).toContain('### Actions');
    expect(ctx.files.get(PLAN_SOURCE)).toContain('- Action 1 {#act-1 bead=b-1}');

    // 2. Edit actions of requirement a
    await ctx.open(
      'edit-act',
      [
        '## MODIFIED Requirement: alpha {#a}',
        '',
        'Alpha as planned.',
        '',
        '### Actions',
        '- [ ] Action 1 modified {#act-1 bead=b-2}',
        '- [ ] Action 2 {#act-2}',
      ].join('\n'),
    );
    const arch2 = await ctx.archive('edit-act');
    expect(arch2.outcome).toBe('archived');

    state = await ctx.state();
    headA = state.plans.get('plan/p')?.heads.get('a');
    expect(headA?.actions).toHaveLength(2);
    expect(headA?.actions?.[0]?.text).toBe('Action 1 modified');
    expect(headA?.actions?.[0]?.workItems).toEqual(['b-2']);
    expect(headA?.actions?.[1]?.id).toBe('act-2');
    expect(ctx.files.get(PLAN_SOURCE)).toContain('- Action 1 modified {#act-1 bead=b-2}');
    expect(ctx.files.get(PLAN_SOURCE)).toContain('- Action 2 {#act-2}');

    // 3. Remove actions from requirement a
    await ctx.open(
      'remove-act',
      ['## MODIFIED Requirement: alpha {#a}', '', 'Alpha as planned.'].join('\n'),
    );
    const arch3 = await ctx.archive('remove-act');
    expect(arch3.outcome).toBe('archived');

    state = await ctx.state();
    headA = state.plans.get('plan/p')?.heads.get('a');
    expect(headA?.actions).toBeUndefined();
    expect(ctx.files.get(PLAN_SOURCE)).not.toContain('### Actions');

    // 4. File, base and log agree: ingest is unchanged
    const after = await ctx.ingestFiles();
    expect(after.files[0]).toMatchObject({ outcome: 'unchanged', requirements: [] });
  });

  test('refuses to update plan file if local plan file has unrecorded action edits', async () => {
    const ctx = await setup();
    await ctx.open(
      'add-act',
      [
        '## MODIFIED Requirement: alpha {#a}',
        '',
        'Alpha as planned.',
        '',
        '### Actions',
        '- [ ] Action 1 {#act-1}',
      ].join('\n'),
    );
    // Locally edit beta's actions without ingesting
    const localEdit = PLAN.replace(
      'Beta as planned.',
      'Beta as planned.\n\n### Actions\n- [ ] Unrecorded action {#act-unrecorded}',
    );
    ctx.files.set(PLAN_SOURCE, localEdit);

    const result = await ctx.archive('add-act');
    expect(result).toMatchObject({
      outcome: 'archived',
      planFile: { updated: false, source: PLAN_SOURCE, reason: 'out-of-step' },
    });
    expect(ctx.files.get(PLAN_SOURCE)).toBe(localEdit);
  });

  test('conflict check prevents archiving action changes if requirement moved', async () => {
    const ctx = await setup();
    await ctx.open(
      'act-chg',
      [
        '## MODIFIED Requirement: alpha {#a}',
        '',
        'Alpha as planned.',
        '',
        '### Actions',
        '- [ ] Action 1 {#act-1}',
      ].join('\n'),
    );
    await ctx.open(
      'text-chg',
      '## MODIFIED Requirement: alpha {#a}\n\nAlpha, completely new text.',
    );
    const pinned = planHeads(await ctx.state(), 'plan/p').get('a');

    expect((await ctx.archive('text-chg')).outcome).toBe('archived');
    const now = planHeads(await ctx.state(), 'plan/p').get('a');

    const result = await ctx.archive('act-chg');
    expect(result.outcome).toBe('refused');
    expect(result.conflicts).toEqual([
      { requirement: 'a', op: 'modify', expected: pinned, actual: now },
    ]);
  });
});

describe('abandonChange', () => {
  test('closes an open change with its reason and applies nothing', async () => {
    const ctx = await setup();
    const heads = planHeads(await ctx.state(), 'plan/p');
    await ctx.open('tweak', '## MODIFIED Requirement: alpha {#a}\n\nAlpha, revised.');
    const result = await abandonChange({
      store: ctx.store,
      changeId: 'tweak',
      reason: 'superseded by a better idea',
      actor: 'me',
    });
    expect(result.outcome).toBe('abandoned');
    const state = await ctx.state();
    expect(state.changes.get('tweak')).toMatchObject({
      status: 'abandoned',
      reason: 'superseded by a better idea',
    });
    expect(planHeads(state, 'plan/p')).toEqual(heads);
  });

  test('needs a reason and an open change', async () => {
    const ctx = await setup();
    await ctx.open('tweak', '## MODIFIED Requirement: alpha {#a}\n\nAlpha, revised.');
    const run = (changeId: string, reason: string) =>
      abandonChange({ store: ctx.store, changeId, reason, actor: 'me' });
    expect((await run('tweak', '  ')).problems.map((p) => p.code)).toEqual(['REASON_REQUIRED']);
    expect((await run('nope', 'r')).problems.map((p) => p.code)).toEqual(['CHANGE_NOT_FOUND']);
    await run('tweak', 'r');
    expect((await run('tweak', 'r')).problems.map((p) => p.code)).toEqual(['CHANGE_NOT_OPEN']);
  });
});
