import { describe, expect, test } from 'bun:test';
import { YojanaError } from '@cntxt-labs/yojana-core';
import { MarkdownParser } from '@cntxt-labs/yojana-markdown';
import { MemoryBaseStore, MemoryStore } from '@cntxt-labs/yojana-store';
import { comment } from '../comment.ts';
import { ingest } from '../ingest.ts';
import { projectReview } from '../project.ts';

const parser = new MarkdownParser();

const PLAN = `---
id: plan/r
status: accepted
---

## Requirement: safe rendering {#safe}

The page must escape <script>alert(1)</script> and keep \`code\`.

## Requirement: primer {#primer}

Topics stay short and current.
`;

async function setup() {
  const store = new MemoryStore();
  await store.open();
  const bases = new MemoryBaseStore();
  let files = [{ source: 'plans/r.md', text: PLAN }];
  await ingest({ store, parser, bases, files, actor: 'me' });
  const edit = async (text: string) => {
    files = [{ source: 'plans/r.md', text }];
    await ingest({ store, parser, bases, files, actor: 'me' });
  };
  const content = async () =>
    projectReview({
      events: await store.events(),
      planId: 'plan/r',
      checks: [],
      now: 0,
      mode: 'read',
    });
  return { store, edit, content };
}

describe('comment', () => {
  test('records a note on the current revision, with an optional quote and reply', async () => {
    const { store } = await setup();
    const first = await comment({
      store,
      planId: 'plan/r',
      requirement: 'primer',
      body: 'Which topics?',
      author: 'reviewer',
      quote: 'stay short',
    });
    expect(first).toMatchObject({
      ok: true,
      annotation: { requirement: 'primer', quote: 'stay short' },
    });
    if (!first.ok) throw new YojanaError('TEST_FIXTURE', first.message);
    const reply = await comment({
      store,
      planId: 'plan/r',
      requirement: 'primer',
      body: 'overview, wql, fusion.',
      author: 'author',
      replyTo: first.annotation.id,
    });
    expect(reply.ok).toBe(true);
  });

  test('refuses an unknown plan, requirement, quote or reply, and empty text', async () => {
    const { store } = await setup();
    const run = (extra: Partial<Parameters<typeof comment>[0]>) =>
      comment({ store, planId: 'plan/r', requirement: 'primer', body: 'x', author: 'a', ...extra });
    expect(await run({ planId: 'plan/none' })).toMatchObject({ ok: false, code: 'PLAN_NOT_FOUND' });
    expect(await run({ requirement: 'nope' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await run({ quote: 'not in the text' })).toMatchObject({ code: 'QUOTE_NOT_FOUND' });
    expect(await run({ replyTo: 'n_missing' })).toMatchObject({ code: 'COMMENT_NOT_FOUND' });
    expect(await run({ body: '   ' })).toMatchObject({ code: 'EMPTY_COMMENT' });
  });
});

describe('comments on the page', () => {
  test('a quote is marked while current; the thread goes outdated when the text changes', async () => {
    const ctx = await setup();
    await comment({
      store: ctx.store,
      planId: 'plan/r',
      requirement: 'primer',
      body: 'Name the topics.',
      author: 'reviewer',
      quote: 'stay short',
    });
    const before = await ctx.content();
    expect(before?.threads[0]).toMatchObject({ mark: '1', outdated: false });
    expect(before?.sections[1]?.body).toMatchObject({ marks: [{ text: 'stay short', id: '1' }] });

    await ctx.edit(PLAN.replace('Topics stay short and current.', 'Topics: overview, wql.'));
    const after = await ctx.content();
    expect(after?.threads[0]).toMatchObject({ outdated: true });
    expect(after?.threads[0]?.mark).toBeUndefined();
    expect(after?.sections[1]?.body).not.toHaveProperty('marks');
  });
});

describe('quotes selected on the rendered page', () => {
  test('match despite lost Markdown marks and line breaks, but a made-up quote is refused', async () => {
    const { store } = await setup();
    const run = (quote: string) =>
      comment({ store, planId: 'plan/r', requirement: 'safe', body: 'x', author: 'a', quote });
    // The page shows `code` without backticks; the selection carries none.
    expect((await run('and keep code')).ok).toBe(true);
    // It still gets its number, placed where it reads.
    const [thread] = (await setupContent(store)) ?? [];
    expect(thread).toMatchObject({ quote: 'and keep code', mark: '1' });
    expect((await run('keep   code.')).ok).toBe(true);
    expect(await run('keep the code')).toMatchObject({ ok: false, code: 'QUOTE_NOT_FOUND' });
  });
});

async function setupContent(store: MemoryStore) {
  return projectReview({
    events: await store.events(),
    planId: 'plan/r',
    checks: [],
    now: 0,
    mode: 'read',
  })?.threads;
}
