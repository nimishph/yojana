import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type IntentHandler, loadTemplate, renderPart } from '@cntxt-labs/patra-core';
import { templateDir } from '@cntxt-labs/patra-templates';
import { type VerifierPort, type WorkLinkPort, YojanaError } from '@cntxt-labs/yojana-core';
import { ingest } from '../ingest.ts';
import { type ReviewIntent, type ReviewSession, reviewSession } from '../session.ts';
import { loadPlanFiles, openWorkspace } from '../workspace.ts';

const loaded = loadTemplate(templateDir('review-document'));
if (!loaded.ok) throw new YojanaError('TEST_FIXTURE', JSON.stringify(loaded.problems));
const template = loaded.template;

const PLAN = `---
id: plan/s
status: accepted
---

# Session plan

## Requirement: first {#first beads=b-1}

The first requirement reads plainly.

\`\`\`yojana:claim
kind: fake
expression: present
\`\`\`

## Requirement: second {#second}

The second one.
`;

const fake: VerifierPort = {
  name: 'fake',
  kinds: ['fake'],
  verify: async (requirement, claim) => ({ requirement, claim, outcome: 'holds', evidence: 'ok' }),
};
let bdCalls = 0;
const closed = new Set<string>();
const tracker: WorkLinkPort = {
  name: 'fake',
  get: async (ids) => {
    bdCalls += 1;
    return {
      ok: true,
      items: ids.map((id) => ({ id, title: id, state: closed.has(id) ? 'closed' : 'open' })),
    };
  },
  children: async () => ({ ok: true, items: [] }),
  close: async (id) => {
    closed.add(id);
    return { ok: true };
  },
};

let root: string;
let session: ReviewSession;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'yojana-session-'));
  mkdirSync(join(root, 'plans'));
  writeFileSync(join(root, 'plans', 's.md'), PLAN);
  const ws = openWorkspace(root);
  await ws.store.open();
  await ingest({
    store: ws.store,
    parser: ws.parser,
    bases: ws.bases,
    files: loadPlanFiles(root, ws.plansDir),
    actor: 'me',
  });
  await ws.store.close();
  session = reviewSession({
    root,
    runCheck: true,
    verifiers: () => [fake],
    worklink: () => tracker,
    you: 'me',
  });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const intent = (
  action: string,
  key: string,
  payload: Record<string, string> = {},
  version?: string,
): ReviewIntent => ({
  template: 'review-document',
  document: 'plan/s',
  action,
  target: { part: 'section', key },
  ...(version === undefined ? {} : { version }),
  payload,
  actor: 'me',
});

const section = async (id: string) =>
  (await session.load('review-document', 'plan/s'))?.sections.find((s) => s.id === id);

describe('review session', () => {
  test("its handler is patra's IntentHandler, and what it loads is valid content", async () => {
    const handler: IntentHandler = session.handle;
    expect(handler).toBeFunction();
    const content = await session.load('review-document', 'plan/s');
    expect(template.check(content)).toEqual([]);
    expect(content?.sections[0]).toMatchObject({ tags: ['close', 'attention', 'unapproved'] });
    expect(await session.load('review-document', 'plan/none')).toBeUndefined();
    expect(await session.load('other', 'plan/s')).toBeUndefined();
    expect(await session.plans()).toEqual([{ id: 'plan/s', status: 'accepted', requirements: 2 }]);
  });

  test('edit writes the plan file and answers with the section, rendered by patra', async () => {
    const before = await section('second');
    const answer = await session.handle(
      intent(
        'edit',
        'second',
        { title: 'second', text: 'The second one, sharper.' },
        before?.version,
      ),
    );
    expect(answer).toMatchObject({
      ok: true,
      update: { kind: 'part', part: 'section', key: 'second' },
    });
    if (!answer.ok || answer.update.kind !== 'part') throw new YojanaError('TEST', 'no part');
    const html = renderPart(template, 'section', answer.update.content);
    expect(html.ok && html.html).toContain('The second one, sharper.');
    expect(readFileSync(join(root, 'plans', 's.md'), 'utf8')).toContain('The second one, sharper.');

    const stale = await session.handle(
      intent('edit', 'second', { title: 'second', text: 'Late.' }, before?.version),
    );
    expect(stale).toMatchObject({ ok: false, code: 'STALE', current: { id: 'second' } });
    expect(!stale.ok && stale.message).toContain('The second one, sharper.');
  });

  test('comment and reply record threads; a reply finds its requirement from the thread', async () => {
    expect(
      await session.handle(
        intent('comment', 'first', { body: 'Plain how?', quote: 'reads plainly' }),
      ),
    ).toEqual({ ok: true, update: { kind: 'page' } });
    const thread = (await session.load('review-document', 'plan/s'))?.threads[0];
    expect(thread).toMatchObject({ section: 'first', mark: '1', author: 'me' });
    const reply = await session.handle({
      ...intent('reply', thread?.id ?? '', { body: 'Short words.' }),
      target: { part: 'thread', key: thread?.id ?? '' },
    });
    expect(reply.ok).toBe(true);
    expect((await session.load('review-document', 'plan/s'))?.threads[0]?.replies).toHaveLength(1);
    expect(await session.handle(intent('reply', 'n_gone', { body: 'x' }))).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
    });
    expect(await session.handle(intent('comment', 'first', { body: ' ' }))).toMatchObject({
      ok: false,
      code: 'EMPTY_COMMENT',
    });
  });

  test('remove takes off a reply (by item) or the thread itself; only for their author', async () => {
    const thread = (await session.load('review-document', 'plan/s'))?.threads[0];
    const replyId = thread?.replies[0]?.id ?? '';
    const remove = (key: string, item = '', actor = 'me') =>
      session.handle({
        ...intent('remove', key, item === '' ? {} : { item }),
        target: { part: 'thread', key },
        actor,
      });
    expect(await remove(thread?.id ?? '', replyId, 'ana')).toMatchObject({ code: 'NOT_YOURS' });
    expect(await remove(thread?.id ?? '', replyId)).toEqual({ ok: true, update: { kind: 'page' } });
    expect((await session.load('review-document', 'plan/s'))?.threads[0]?.replies).toEqual([]);
    expect((await remove(thread?.id ?? '')).ok).toBe(true);
    expect((await session.load('review-document', 'plan/s'))?.threads).toEqual([]);
  });

  test('decline-section declines a requirement with a reason, checked against the revision', async () => {
    const section = (await session.load('review-document', 'plan/s'))?.sections[0];
    expect(section?.buttons).toContainEqual({ action: 'decline-section', label: 'Decline' });
    expect(
      await session.handle(intent('decline-section', 'first', { reason: '' }, section?.version)),
    ).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    expect(
      await session.handle(intent('decline-section', 'first', { reason: 'x' }, 'r_old')),
    ).toMatchObject({ ok: false, code: 'STALE' });
    expect(
      await session.handle(
        intent('decline-section', 'first', { reason: 'Say who reads it.' }, section?.version),
      ),
    ).toEqual({ ok: true, update: { kind: 'page' } });
    const after = (await session.load('review-document', 'plan/s'))?.sections[0];
    expect(after?.properties).toContainEqual({
      label: 'declined by me: Say who reads it.',
      intent: 'danger',
    });
  });

  test('suggest opens a change; reject needs a reason, then settles the change file', async () => {
    const first = await section('first');
    expect(
      await session.handle(
        intent(
          'suggest',
          'first',
          { title: 'first', text: 'Reads simply.', why: 'shorter' },
          first?.version,
        ),
      ),
    ).toEqual({ ok: true, update: { kind: 'page' } });
    const change = (await session.load('review-document', 'plan/s'))?.changes[0];
    expect(change).toMatchObject({ applies: true, author: 'me' });
    const id = change?.id ?? '';
    expect(await session.handle(intent('reject', id, { reason: '' }))).toMatchObject({
      ok: false,
      code: 'REASON_REQUIRED',
    });
    expect((await session.handle(intent('reject', id, { reason: 'too terse' }))).ok).toBe(true);
    expect(existsSync(join(root, 'changes', `${id}.md`))).toBe(false);
    expect(readdirSync(join(root, 'changes', 'abandoned'))).toHaveLength(1);
  });

  test('accept applies a suggestion to the plan file and archives it', async () => {
    const first = await section('first');
    await session.handle(
      intent('suggest', 'first', { title: 'first', text: 'Reads clearly.' }, first?.version),
    );
    const id = (await session.load('review-document', 'plan/s'))?.changes[0]?.id ?? '';
    expect(await session.handle(intent('accept', id))).toEqual({
      ok: true,
      update: { kind: 'page' },
    });
    expect(readFileSync(join(root, 'plans', 's.md'), 'utf8')).toContain('Reads clearly.');
    expect(readdirSync(join(root, 'changes', 'archive'))).toHaveLength(1);
    expect((await section('first'))?.body).toMatchObject({ source: 'Reads clearly.' });
  });

  test('refresh asks the tracker again; unknown actions are refused', async () => {
    await session.load('review-document', 'plan/s');
    const before = bdCalls;
    await session.load('review-document', 'plan/s');
    expect(bdCalls).toBe(before);
    expect(await session.handle(intent('refresh', ''))).toEqual({
      ok: true,
      update: { kind: 'page' },
    });
    await session.load('review-document', 'plan/s');
    expect(bdCalls).toBeGreaterThan(before);
    expect(await session.handle(intent('launch', 'first'))).toMatchObject({ code: 'UNSUPPORTED' });
    expect(await session.handle({ ...intent('edit', 'first'), template: 'x' })).toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  test('decide closes the work item at once, and the page shows it closed', async () => {
    expect(
      await session.handle(
        intent('decide', 'first', { item: 'b-1', decision: 'close', reason: '' }),
      ),
    ).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    expect(
      await session.handle(
        intent('decide', 'first', { item: 'b-1', decision: 'close', reason: 'claims hold' }),
      ),
    ).toEqual({ ok: true, update: { kind: 'page' } });
    expect(closed.has('b-1')).toBe(true);
    const content = await session.load('review-document', 'plan/s');
    const first = content?.sections.find((s) => s.id === 'first');
    expect(first?.properties[0]).toEqual({ label: 'b-1 · closed', intent: 'success' });
    expect(first?.flags).toBeUndefined();
    const [a, b] = content?.activity ?? [];
    expect([a?.what, b?.what]).toEqual([
      'applied the decision: closed b-1',
      'decided to close b-1: claims hold',
    ]);
  });
});
