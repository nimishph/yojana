import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTemplate } from '@cntxt-labs/patra-core';
import { templateDir } from '@cntxt-labs/patra-templates';
import { foldLog, waitingProposals, YojanaError } from '@cntxt-labs/yojana-core';
import { MarkdownParser } from '@cntxt-labs/yojana-markdown';
import { MemoryBaseStore, MemoryStore } from '@cntxt-labs/yojana-store';
import { ingest } from '../ingest.ts';
import {
  approveRequirement,
  declineRequirement,
  declineStatus,
  finalizeStatus,
  proposeStatus,
} from '../plan-status.ts';
import { projectReview } from '../project.ts';
import { type ReviewIntent, reviewSession } from '../session.ts';
import { loadPlanFiles, openWorkspace } from '../workspace.ts';

const parser = new MarkdownParser();

const plan = (status: string, text = 'It ships.') => `---
id: plan/p
status: ${status}
---

# A plan

## Requirement: shipped {#shipped}

${text}

## Requirement: documented {#documented}

It is documented.
`;

async function setup(status = 'draft') {
  const store = new MemoryStore();
  await store.open();
  const bases = new MemoryBaseStore();
  const ingestAs = (text: string, actor: string, agent: boolean) =>
    ingest({ store, parser, bases, files: [{ source: 'plans/p.md', text }], actor, agent });
  await ingestAs(plan(status), 'me', false);
  const state = async () => foldLog(await store.events());
  return { store, bases, ingestAs, state };
}

describe('status proposals', () => {
  test('an agent proposes; the plan stays until a person finalizes it', async () => {
    const { store, state } = await setup();
    const proposed = await proposeStatus({
      store,
      planId: 'plan/p',
      to: 'accepted',
      reason: 'requirements settled',
      actor: 'claude',
      agent: true,
      finalize: false,
    });
    expect(proposed).toMatchObject({ ok: true, moved: false, proposal: { status: 'proposed' } });
    expect((await state()).plans.get('plan/p')?.status).toBe('draft');

    // Asking again adds nothing; the agent cannot finalize.
    const again = await proposeStatus({
      store,
      planId: 'plan/p',
      to: 'accepted',
      reason: 'again',
      actor: 'claude',
      agent: true,
      finalize: false,
    });
    expect(again.ok && proposed.ok && again.proposal.id).toBe(proposed.ok && proposed.proposal.id);
    const id = proposed.ok ? proposed.proposal.id : '';
    expect(
      await finalizeStatus({ store, proposalId: id, actor: 'claude', agent: true }),
    ).toMatchObject({
      ok: false,
      code: 'PERSON_ONLY',
    });

    const done = await finalizeStatus({ store, proposalId: id, actor: 'me', agent: false });
    expect(done).toMatchObject({
      ok: true,
      moved: true,
      proposal: { status: 'accepted', decidedBy: 'me' },
    });
    const plan = (await state()).plans.get('plan/p');
    expect(plan?.status).toBe('accepted');
    expect(plan?.statusHistory.at(-1)).toMatchObject({
      to: 'accepted',
      reason: 'requirements settled',
      actor: 'me',
    });
    expect(
      await finalizeStatus({ store, proposalId: id, actor: 'me', agent: false }),
    ).toMatchObject({
      code: 'NOT_PROPOSED',
    });
  });

  test('a person declines, saying why; a person may also move the plan in one step', async () => {
    const { store, state } = await setup();
    const proposed = await proposeStatus({
      store,
      planId: 'plan/p',
      to: 'accepted',
      reason: 'ready',
      actor: 'claude',
      agent: true,
      finalize: false,
    });
    const id = proposed.ok ? proposed.proposal.id : '';
    expect(
      await declineStatus({ store, proposalId: id, reason: ' ', actor: 'me', agent: false }),
    ).toMatchObject({
      code: 'REASON_REQUIRED',
    });
    expect(
      await declineStatus({
        store,
        proposalId: id,
        reason: 'too vague',
        actor: 'me',
        agent: false,
      }),
    ).toMatchObject({ ok: true, proposal: { status: 'declined', outcome: 'too vague' } });
    expect((await state()).plans.get('plan/p')?.status).toBe('draft');

    const direct = await proposeStatus({
      store,
      planId: 'plan/p',
      to: 'abandoned',
      reason: 'superseded by another approach',
      actor: 'me',
      agent: false,
      finalize: true,
    });
    expect(direct).toMatchObject({ ok: true, moved: true });
    expect((await state()).plans.get('plan/p')?.status).toBe('abandoned');
  });

  test('what cannot be proposed is refused', async () => {
    const { store } = await setup();
    const ask = (to: string, reason = 'why') =>
      proposeStatus({
        store,
        planId: 'plan/p',
        to,
        reason,
        actor: 'claude',
        agent: true,
        finalize: false,
      });
    expect(await ask('done')).toMatchObject({ code: 'INVALID' });
    expect(await ask('draft')).toMatchObject({ code: 'ALREADY' });
    expect(await ask('accepted', '')).toMatchObject({ code: 'REASON_REQUIRED' });
    expect(await ask('accepted', 'x').then(() => ask('accepted', 'x'))).toMatchObject({ ok: true });
    expect(
      await proposeStatus({
        store,
        planId: 'plan/p',
        to: 'realized',
        reason: 'x',
        actor: 'claude',
        agent: true,
        finalize: true,
      }),
    ).toMatchObject({ code: 'PERSON_ONLY' });
  });
});

describe('ingest and the status line', () => {
  test("an agent's status edit becomes one proposal, and the base keeps the log's status", async () => {
    const { ingestAs, bases, state } = await setup();
    const report = await ingestAs(plan('accepted'), 'claude', true);
    expect(report.files[0]?.status).toMatchObject({ movement: 'edited', proposed: true });
    expect((await state()).plans.get('plan/p')?.status).toBe('draft');
    expect((await bases.get('plan/p'))?.status).toBe('draft');
    await ingestAs(plan('accepted'), 'claude', true);
    expect(waitingProposals(await state(), 'plan/p')).toHaveLength(1);
  });

  test('a new plan an agent writes starts as draft, its status proposed', async () => {
    const store = new MemoryStore();
    await store.open();
    await ingest({
      store,
      parser,
      bases: new MemoryBaseStore(),
      files: [{ source: 'plans/p.md', text: plan('accepted') }],
      actor: 'claude',
      agent: true,
    });
    const state = foldLog(await store.events());
    expect(state.plans.get('plan/p')?.status).toBe('draft');
    expect(waitingProposals(state, 'plan/p')).toMatchObject([
      { to: 'accepted', reason: 'set in plans/p.md' },
    ]);
  });

  test("a person's edit to the same status finalizes the waiting proposal", async () => {
    const { ingestAs, state } = await setup();
    await ingestAs(plan('accepted'), 'claude', true);
    await ingestAs(plan('accepted'), 'me', false);
    const s = await state();
    expect(s.plans.get('plan/p')?.status).toBe('accepted');
    expect([...s.proposals.values()]).toMatchObject([{ status: 'accepted', decidedBy: 'me' }]);
  });
});

describe('approvals', () => {
  test('a person approves a revision; it goes stale when the requirement moves', async () => {
    const { store, ingestAs, state } = await setup();
    const approve = (agent = false, revision?: string) =>
      approveRequirement({
        store,
        planId: 'plan/p',
        requirement: 'shipped',
        revision,
        actor: agent ? 'claude' : 'me',
        agent,
      });
    expect(await approve(true)).toMatchObject({ code: 'PERSON_ONLY' });
    const first = await approve();
    expect(first).toMatchObject({ ok: true, already: false });
    expect(await approve()).toMatchObject({ ok: true, already: true });

    await ingestAs(plan('draft', 'It ships, with notes.'), 'me', false);
    expect(await approve(false, first.ok ? first.revision : '')).toMatchObject({ code: 'STALE' });
    const events = await store.events();
    const doc = projectReview({
      events,
      planId: 'plan/p',
      checks: [],
      now: Date.now(),
      mode: 'read',
    });
    expect(doc?.sections[0]?.properties).toContainEqual({
      label: 'approved by me, changed since',
      intent: 'warning',
    });
    expect(doc?.sections[0]?.buttons).toEqual([
      { action: 'approve', label: 'Approve again' },
      { action: 'decline-section', label: 'Decline' },
    ]);
    expect(doc?.document.metrics.at(-1)).toEqual({ label: '0/2 approved' });
    expect((await state()).plans.get('plan/p')?.approvals.size).toBe(1);
  });
});

describe('declining a requirement', () => {
  test('a person declines with a reason; approving later replaces it', async () => {
    const { store, state } = await setup();
    const decline = (reason: string, agent = false) =>
      declineRequirement({
        store,
        planId: 'plan/p',
        requirement: 'shipped',
        reason,
        actor: agent ? 'claude' : 'me',
        agent,
      });
    expect(await decline('vague', true)).toMatchObject({ code: 'PERSON_ONLY' });
    expect(await decline('  ')).toMatchObject({ code: 'REASON_REQUIRED' });
    expect(await decline('say which release')).toMatchObject({ ok: true, already: false });
    expect(await decline('say which release')).toMatchObject({ ok: true, already: true });

    const project = async () =>
      projectReview({
        events: await store.events(),
        planId: 'plan/p',
        checks: [],
        now: Date.now(),
        mode: 'read',
      });
    const declined = await project();
    const section = declined?.sections.find((x) => x.id === 'shipped');
    expect(section?.properties).toContainEqual({
      label: 'declined by me: say which release',
      intent: 'danger',
    });
    expect(section?.tags).toEqual(['declined', 'attention', 'unapproved']);
    expect(section?.buttons).toEqual([{ action: 'approve', label: 'Approve' }]);
    expect(declined?.callouts[0]?.notes?.[0]).toEqual({
      label: '1 requirement declined',
      intent: 'danger',
    });
    expect(declined?.activity[0]?.what).toBe('declined “shipped”: say which release');

    // Approving after a decline is a new verdict, not "already approved".
    expect(
      await approveRequirement({
        store,
        planId: 'plan/p',
        requirement: 'shipped',
        actor: 'me',
        agent: false,
      }),
    ).toMatchObject({ ok: true, already: false });
    expect((await state()).plans.get('plan/p')?.approvals.get('shipped')?.verdict).toBe('approved');
    expect((await project())?.sections.find((x) => x.id === 'shipped')?.buttons).toBeUndefined();
  });
});

describe('the review page', () => {
  const root = mkdtempSync(join(tmpdir(), 'yojana-plan-status-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const loaded = loadTemplate(templateDir('review-document'));
  if (!loaded.ok) throw new YojanaError('TEST_FIXTURE', JSON.stringify(loaded.problems));
  const template = loaded.template;

  const file = () => readFileSync(join(root, 'plans', 'p.md'), 'utf8');
  const intent = (
    action: string,
    part: string,
    key: string,
    payload: Record<string, string> = {},
    version?: string,
  ): ReviewIntent => ({
    template: 'review-document',
    document: 'plan/p',
    action,
    target: { part, key },
    ...(version === undefined ? {} : { version }),
    payload,
    actor: 'me',
  });
  const session = reviewSession({
    root,
    runCheck: false,
    verifiers: () => [],
    worklink: () => ({
      name: 'none',
      get: async () => ({ ok: true, items: [] }),
      children: async () => ({ ok: true, items: [] }),
    }),
    you: 'me',
  });
  const asAgent = async (text: string) => {
    writeFileSync(join(root, 'plans', 'p.md'), text);
    const ws = openWorkspace(root);
    await ws.store.open();
    await ingest({
      store: ws.store,
      parser: ws.parser,
      bases: ws.bases,
      files: loadPlanFiles(root, ws.plansDir),
      actor: 'claude',
      agent: true,
    });
    await ws.store.close();
  };

  test('a draft offers Accept, with what to weigh; approving changes the count', async () => {
    mkdirSync(join(root, 'plans'), { recursive: true });
    writeFileSync(join(root, 'plans', 'p.md'), plan('draft'));
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

    const content = await session.load('review-document', 'plan/p');
    expect(template.check(content)).toEqual([]);
    expect(content?.callouts).toEqual([
      {
        id: 'next',
        text: 'This plan is a draft. Accept it once its requirements say what you want.',
        intent: 'neutral',
        notes: [{ label: '2 of 2 requirements not approved, or changed since', intent: 'warning' }],
        buttons: [{ action: 'confirm', label: 'Accept the plan', decision: 'accepted' }],
      },
    ]);
    const shipped = content?.sections.find((s) => s.id === 'shipped');
    expect(
      await session.handle(intent('approve', 'section', 'shipped', {}, 'r_old')),
    ).toMatchObject({ ok: false, code: 'STALE' });
    expect(
      await session.handle(intent('approve', 'section', 'shipped', {}, shipped?.version)),
    ).toEqual({ ok: true, update: { kind: 'page' } });
    const after = await session.load('review-document', 'plan/p');
    expect(after?.callouts[0]?.notes?.[0]?.label).toBe(
      '1 of 2 requirements not approved, or changed since',
    );
    expect(after?.sections.find((s) => s.id === 'shipped')?.buttons).toBeUndefined();
  });

  test("declining an agent's status edit puts the file's status line back", async () => {
    await asAgent(plan('accepted'));
    const content = await session.load('review-document', 'plan/p');
    const callout = content?.callouts[0];
    expect(callout).toMatchObject({
      text: 'claude proposes moving this plan from draft to accepted: “edited in plans/p.md”',
      buttons: [{ action: 'confirm', decision: 'accepted' }, { action: 'decline' }],
    });
    expect(
      await session.handle(intent('decline', 'callout', callout?.id ?? '', { reason: '' })),
    ).toMatchObject({ code: 'REASON_REQUIRED' });
    expect(
      (await session.handle(intent('decline', 'callout', callout?.id ?? '', { reason: 'not yet' })))
        .ok,
    ).toBe(true);
    expect(file()).toContain('status: draft');
    expect((await session.load('review-document', 'plan/p'))?.callouts[0]?.id).toBe('next');
  });

  test('confirming moves the plan and its file; the offer then moves on', async () => {
    expect(
      (await session.handle(intent('confirm', 'callout', 'next', { decision: 'accepted' }))).ok,
    ).toBe(true);
    expect(file()).toContain('status: accepted');
    const content = await session.load('review-document', 'plan/p');
    expect(content?.document.status).toEqual({ label: 'accepted', intent: 'primary' });
    expect(content?.callouts[0]?.buttons).toEqual([
      { action: 'confirm', label: 'Move to in-progress', decision: 'in-progress' },
    ]);
    expect(content?.activity[0]).toMatchObject({ kind: 'you', what: 'moved the plan to accepted' });
    expect(
      await session.handle(intent('decline', 'callout', 'next', { reason: 'x' })),
    ).toMatchObject({ code: 'NOT_FOUND' });
  });
});
