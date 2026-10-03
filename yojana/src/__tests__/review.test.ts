import { describe, expect, test } from 'bun:test';
import { YojanaError } from '@cntxt-labs/yojana-core';
import { MarkdownParser } from '@cntxt-labs/yojana-markdown';
import { MemoryBaseStore, MemoryStore } from '@cntxt-labs/yojana-store';
import { comment } from '../comment.ts';
import { ingest } from '../ingest.ts';
import { escapeHtml, renderMarkdown, review } from '../review.ts';
import { status } from '../status.ts';

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
  const page = async () =>
    (await review({
      store,
      planId: 'plan/r',
      status: await status({ store, parser, bases, files, now: 0, staleDays: 14 }),
      generatedAt: 0,
    })) ?? '';
  return { store, edit, page };
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

describe('review page', () => {
  test('escapes plan text: markup in a requirement is shown, never run', async () => {
    const html = await (await setup()).page();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('id="safe"');
  });

  test('a quoted span is highlighted while current; the note goes outdated when the text changes', async () => {
    const ctx = await setup();
    await comment({
      store: ctx.store,
      planId: 'plan/r',
      requirement: 'primer',
      body: 'Name the topics.',
      author: 'reviewer',
      quote: 'stay short',
    });
    const before = await ctx.page();
    expect(before).toContain('<mark>stay short</mark>');
    expect(before).not.toContain('>outdated<');

    await ctx.edit(PLAN.replace('Topics stay short and current.', 'Topics: overview, wql.'));
    const after = await ctx.page();
    expect(after).toContain('>outdated<');
    expect(after).not.toContain('<mark>');
    expect(after).toContain('1 comment (1 outdated)');
  });

  test('renderMarkdown keeps fences, lists and headings, escapes the rest', () => {
    const html = renderMarkdown(
      'Intro **bold** <b>x</b>\n\n- one\n- two\n\n### Sub\n\n```\n<a>\n```',
    );
    expect(html).toContain('<strong>bold</strong> &lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<h4>Sub</h4>');
    expect(html).toContain('<pre><code>&lt;a&gt;</code></pre>');
    expect(escapeHtml(`"'&`)).toBe('&quot;&#39;&amp;');
  });

  test('an unknown plan has no page', async () => {
    const { store } = await setup();
    expect(
      await review({
        store,
        planId: 'plan/none',
        status: { plans: [], untracked: [], anomalies: [] },
        generatedAt: 0,
      }),
    ).toBeUndefined();
  });
});

describe('quotes selected on the rendered page', () => {
  test('match despite lost Markdown marks and line breaks, but a made-up quote is refused', async () => {
    const { store } = await setup();
    const run = (quote: string) =>
      comment({ store, planId: 'plan/r', requirement: 'safe', body: 'x', author: 'a', quote });
    // The page shows `code` without backticks; the selection carries none.
    expect((await run('and keep code')).ok).toBe(true);
    expect((await run('keep   code.')).ok).toBe(true);
    expect(await run('keep the code')).toMatchObject({ ok: false, code: 'QUOTE_NOT_FOUND' });
  });
});
