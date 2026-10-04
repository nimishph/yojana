import { describe, expect, test } from 'bun:test';
import { loadTemplate } from '@cntxt-labs/patra-core';
import { templateDir } from '@cntxt-labs/patra-templates';
import {
  foldLog,
  type VerifierPort,
  type WorkItem,
  type WorkLinkPort,
  YojanaError,
} from '@cntxt-labs/yojana-core';
import { MarkdownParser } from '@cntxt-labs/yojana-markdown';
import { MemoryBaseStore, MemoryStore } from '@cntxt-labs/yojana-store';
import { check } from '../check.ts';
import { comment } from '../comment.ts';
import { suggestEdit } from '../edit.ts';
import { ingest } from '../ingest.ts';
import { projectReview } from '../project.ts';
import { status } from '../status.ts';

const parser = new MarkdownParser();
const loaded = loadTemplate(templateDir('review-document'));
if (!loaded.ok) throw new YojanaError('TEST_FIXTURE', JSON.stringify(loaded.problems));
const template = loaded.template;

const PLAN = `---
id: plan/p
status: in-progress
---

# Search that explains itself

Why this plan exists, in a sentence.

## Requirement: done but open {#done-open beads=b-open}

Results carry a reason. Every hit says why it matched.

\`\`\`yojana:claim
kind: fake
expression: present
\`\`\`

## Requirement: closed but broken {#closed-broken beads=b-closed}

The old ranker is gone.

\`\`\`yojana:claim
kind: fake
expression: absent
\`\`\`

## Requirement: unlinked {#unlinked}

Plain text, no claims.
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
      evidence: found ? '1 match' : 'no match',
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

const HOUR = 3_600_000;

async function setup() {
  const store = new MemoryStore();
  await store.open();
  const bases = new MemoryBaseStore();
  const files = [{ source: 'plans/p.md', text: PLAN }];
  await ingest({ store, parser, bases, files, actor: 'me' });
  // Comments are written out of text order: the later quote first.
  const later = await comment({
    store,
    planId: 'plan/p',
    requirement: 'done-open',
    body: 'Even fuzzy hits?',
    author: 'claude',
    quote: 'Every hit',
  });
  const earlier = await comment({
    store,
    planId: 'plan/p',
    requirement: 'done-open',
    body: 'What is a reason?',
    author: 'me',
    quote: 'carry a reason',
  });
  if (!later.ok || !earlier.ok) throw new YojanaError('TEST_FIXTURE', 'comment failed');
  const reply = await comment({
    store,
    planId: 'plan/p',
    requirement: 'done-open',
    body: 'Yes, all of them.',
    author: 'me',
    replyTo: later.annotation.id,
  });
  if (!reply.ok) throw new YojanaError('TEST_FIXTURE', 'reply failed');
  await comment({
    store,
    planId: 'plan/p',
    requirement: 'done-open',
    body: 'Agreed.',
    author: 'claude',
    replyTo: reply.annotation.id,
  });
  const head = foldLog(await store.events())
    .plans.get('plan/p')
    ?.heads.get('unlinked');
  const suggested = await suggestEdit({
    store,
    parser,
    planId: 'plan/p',
    requirementId: 'unlinked',
    expectedRevision: head?.revision ?? '',
    title: 'unlinked',
    text: 'Plain text, now with claims.',
    actor: 'claude',
    why: 'clearer',
    changesDir: 'changes',
    writeChange: () => undefined,
  });
  if (!suggested.ok) throw new YojanaError('TEST_FIXTURE', suggested.message);

  const checks = await check({ store, verifiers: [fake], planId: 'plan/p' });
  const events = await store.events();
  const now = (events.at(-1)?.at ?? 0) + 2 * HOUR;
  const report = await status({
    store,
    parser,
    bases,
    files,
    worklink: tracker,
    checks,
    now,
    staleDays: 14,
    planId: 'plan/p',
  });
  const parsed = parser.parse('plans/p.md', PLAN);
  if (!parsed.ok) throw new YojanaError('TEST_FIXTURE', JSON.stringify(parsed.issues));
  const project = (mode: 'read' | 'suggest' | 'edit' = 'suggest') =>
    projectReview({
      events,
      planId: 'plan/p',
      plan: parsed.plan,
      report: report.plans[0],
      checks: checks.plans[0]?.results ?? [],
      checkedAt: now,
      now,
      mode,
      repository: 'repo',
      you: 'me',
    });
  return { project, changeId: suggested.changeId };
}

describe('projector', () => {
  test("the projection is valid content for patra's review-document template", async () => {
    const content = (await setup()).project();
    expect(content).toBeDefined();
    expect(template.check(content)).toEqual([]);
  });

  test('an unknown plan projects to nothing', () => {
    expect(
      projectReview({ events: [], planId: 'plan/none', checks: [], now: 0, mode: 'read' }),
    ).toBeUndefined();
  });

  test('the document: title and intro from the file, status, metrics, freshness', async () => {
    const doc = (await setup()).project()?.document;
    expect(doc).toMatchObject({
      id: 'plan/p',
      title: 'Search that explains itself',
      crumbs: 'repo / plans/p.md',
      status: { label: 'in-progress', intent: 'primary' },
      mode: 'suggest',
      intro: { kind: 'markdown', source: 'Why this plan exists, in a sentence.' },
      source: 'plans/p.md',
      freshness: 'claims checked just now',
    });
    expect(doc?.metrics.map((m) => m.label)).toEqual([
      '1 hold',
      '1 violated',
      'file in step',
      '0/3 approved',
    ]);
  });

  test('health, tags and flags: close?, reopen?, and an open change', async () => {
    const content = (await setup()).project();
    const [doneOpen, closedBroken, unlinked] = content?.sections ?? [];
    expect(doneOpen).toMatchObject({
      health: 'success',
      tags: ['close', 'attention', 'unapproved'],
      note: 'close? · 2 threads',
      flags: [
        {
          text: 'Every claim holds but b-open is still open.',
          buttons: [{ action: 'decide', item: 'b-open', decision: 'close', primary: true }],
        },
      ],
    });
    expect(doneOpen?.properties).toEqual([
      { label: 'b-open · open' },
      { label: '1/1 claims hold', intent: 'success' },
    ]);
    expect(closedBroken).toMatchObject({
      health: 'danger',
      tags: ['violated', 'attention', 'unapproved'],
      note: 'reopen?',
      flags: [{ intent: 'danger', buttons: [{ decision: 'reopen', item: 'b-closed' }] }],
      evidence: [{ label: 'fake absent · no match', intent: 'danger' }],
    });
    expect(unlinked).toMatchObject({
      health: 'neutral',
      tags: ['attention', 'unapproved'],
      note: '1 change',
      proposed: {
        kind: 'diff',
        before: 'Plain text, no claims.',
        after: 'Plain text, now with claims.',
      },
    });
    expect(content?.filters).toEqual([
      { id: 'attention', label: 'Needs attention', count: 3, active: true },
      { id: 'close', label: 'Close?', count: 1 },
      { id: 'violated', label: 'Violated', count: 1 },
      { id: 'unapproved', label: 'Not approved', count: 3 },
    ]);
  });

  test('marks are numbered in text order, and threads are one level deep', async () => {
    const content = (await setup()).project();
    const body = content?.sections[0]?.body;
    expect(body).toMatchObject({
      marks: expect.arrayContaining([
        { text: 'carry a reason', id: '1' },
        { text: 'Every hit', id: '2' },
      ]),
    });
    const [later, earlier] = content?.threads ?? [];
    expect(later).toMatchObject({ mark: '2', quote: 'Every hit', author: 'claude', agent: true });
    expect(later?.replies.map((r) => r.body)).toEqual(['Yes, all of them.', 'Agreed.']);
    expect(earlier).toMatchObject({ mark: '1', outdated: false, replies: [] });
    expect(content?.threads).toHaveLength(2);
  });

  test('open changes, and activity as sentences, newest first', async () => {
    const { project, changeId } = await setup();
    const content = project();
    expect(content?.changes).toEqual([
      {
        id: changeId,
        title: 'Suggested edit to unlinked',
        author: 'claude',
        when: '2h',
        status: { label: 'applies cleanly', intent: 'success' },
        applies: true,
        diffs: [
          {
            section: 'unlinked',
            label: 'modify · unlinked',
            diff: {
              kind: 'diff',
              before: 'Plain text, no claims.',
              after: 'Plain text, now with claims.',
            },
          },
        ],
      },
    ]);
    const activity = content?.activity ?? [];
    expect(activity[0]).toMatchObject({
      who: 'claude',
      kind: 'agent',
      what: 'opened “Suggested edit to unlinked”',
    });
    expect(activity.map((a) => a.what)).toContain('commented on “done but open”');
    expect(activity.find((a) => a.who === 'me')?.kind).toBe('you');
    const raw = /annotation-added|revision-recorded|change-opened|work-linked|status-changed/;
    expect(activity.some((a) => raw.test(a.what))).toBe(false);
    expect(activity.map((a) => a.what)).toContain('moved the plan to in-progress');
  });
});
