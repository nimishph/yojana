import { describe, expect, test } from 'bun:test';
import { foldLog, type WorkItem, type WorkLinkPort, YojanaError } from '@cntxt-labs/yojana-core';
import { MarkdownParser } from '@cntxt-labs/yojana-markdown';
import { MemoryBaseStore, MemoryStore } from '@cntxt-labs/yojana-store';
import { applyDecisions, finalizeDecision, recordDecision } from '../decisions.ts';
import { ingest } from '../ingest.ts';
import { projectReview } from '../project.ts';

const parser = new MarkdownParser();

const PLAN = `---
id: plan/d
---

## Requirement: shipped {#shipped beads=b-1,b-2}

It ships.
`;

/** A tracker in memory; `fail` makes the next state change fail with that message. */
function tracker(initial: Record<string, WorkItem['state']>) {
  const states = { ...initial };
  const calls: string[] = [];
  let fail: string | undefined;
  const change = (to: WorkItem['state'], verb: string) => async (id: string, reason: string) => {
    calls.push(`${verb} ${id}: ${reason}`);
    if (fail !== undefined) {
      const error = fail;
      fail = undefined;
      return { ok: false as const, error };
    }
    states[id] = to;
    return { ok: true as const };
  };
  const port: WorkLinkPort = {
    name: 'fake',
    get: async (ids) => ({
      ok: true,
      items: ids.map((id) => ({ id, title: id, state: states[id] ?? ('missing' as const) })),
    }),
    children: async () => ({ ok: true, items: [] }),
    close: change('closed', 'close'),
    reopen: change('open', 'reopen'),
  };
  return {
    port,
    states,
    calls,
    failNext: (message: string) => {
      fail = message;
    },
  };
}

async function setup() {
  const store = new MemoryStore();
  await store.open();
  await ingest({
    store,
    parser,
    bases: new MemoryBaseStore(),
    files: [{ source: 'plans/d.md', text: PLAN }],
    actor: 'me',
  });
  const decide = (extra: Partial<Parameters<typeof recordDecision>[0]> = {}) =>
    recordDecision({
      store,
      planId: 'plan/d',
      requirement: 'shipped',
      item: 'b-1',
      decision: 'close',
      reason: 'every claim holds',
      actor: 'me',
      finalize: true,
      ...extra,
    });
  const decisions = async () => [...foldLog(await store.events()).decisions.values()];
  return { store, decide, decisions };
}

describe('decisions', () => {
  test('a person decides, the outbox applies it with bd close, and applying again does nothing', async () => {
    const { store, decide, decisions } = await setup();
    const bd = tracker({ 'b-1': 'open', 'b-2': 'open' });
    const recorded = await decide();
    expect(recorded).toMatchObject({
      ok: true,
      decision: { status: 'finalized', finalizedBy: 'me' },
    });
    expect(await applyDecisions({ store, worklink: bd.port, actor: 'me' })).toEqual([
      expect.objectContaining({ item: 'b-1', outcome: 'applied', note: 'closed b-1' }),
    ]);
    expect(bd.calls).toEqual(['close b-1: every claim holds']);
    expect((await decisions())[0]).toMatchObject({ status: 'applied', outcome: 'closed b-1' });
    expect(await applyDecisions({ store, worklink: bd.port, actor: 'me' })).toEqual([]);
    expect(bd.calls).toHaveLength(1);
  });

  test('an item already in the decided state counts as applied, without asking bd to act', async () => {
    const { store, decide } = await setup();
    const bd = tracker({ 'b-1': 'closed' });
    await decide();
    const [result] = await applyDecisions({ store, worklink: bd.port, actor: 'me' });
    expect(result).toMatchObject({ outcome: 'applied', note: 'b-1 was already closed' });
    expect(bd.calls).toEqual([]);
  });

  test("a failure is recorded with bd's message, and the next apply retries it", async () => {
    const { store, decide, decisions } = await setup();
    const bd = tracker({ 'b-1': 'open' });
    await decide();
    bd.failNext('bd close b-1 failed (exit 1): database is locked');
    const [failed] = await applyDecisions({ store, worklink: bd.port, actor: 'me' });
    expect(failed).toMatchObject({ outcome: 'failed' });
    expect((await decisions())[0]).toMatchObject({
      status: 'failed',
      outcome: 'bd close b-1 failed (exit 1): database is locked',
    });
    const [retried] = await applyDecisions({ store, worklink: bd.port, actor: 'me' });
    expect(retried).toMatchObject({ outcome: 'applied' });
    expect(bd.states['b-1']).toBe('closed');
  });

  test('a tracker that cannot change items, or does not know the item, fails the decision', async () => {
    const { store, decide } = await setup();
    const readOnly: WorkLinkPort = {
      name: 'ro',
      get: async (ids) => ({
        ok: true,
        items: ids.map((id) => ({ id, title: id, state: 'open' })),
      }),
      children: async () => ({ ok: true, items: [] }),
    };
    await decide();
    expect((await applyDecisions({ store, worklink: readOnly, actor: 'me' }))[0]?.note).toBe(
      'ro cannot close items from yojana',
    );
    const empty = tracker({});
    expect((await applyDecisions({ store, worklink: empty.port, actor: 'me' }))[0]?.note).toBe(
      'fake has no item b-1',
    );
  });

  test('an agent proposes; nothing is applied until a person finalizes it', async () => {
    const { store, decide } = await setup();
    const bd = tracker({ 'b-1': 'open' });
    const proposed = await decide({ actor: 'claude', finalize: false });
    if (!proposed.ok) throw new YojanaError('TEST', proposed.message);
    expect(proposed.decision.status).toBe('recorded');
    expect(await applyDecisions({ store, worklink: bd.port, actor: 'me' })).toEqual([]);

    // Deciding the same thing on the page finalizes the proposal instead of adding a second.
    const again = await decide({ reason: 'yes' });
    expect(again).toMatchObject({
      ok: true,
      decision: { id: proposed.decision.id, status: 'finalized' },
    });
    expect(
      await finalizeDecision({ store, decisionId: proposed.decision.id, actor: 'me' }),
    ).toMatchObject({
      ok: false,
      code: 'NOT_PROPOSED',
    });
    expect(await applyDecisions({ store, worklink: bd.port, actor: 'me' })).toHaveLength(1);
  });

  test('refuses an unknown requirement, an unlinked item, an unknown decision and no reason', async () => {
    const { decide } = await setup();
    expect(await decide({ requirement: 'nope' })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await decide({ item: 'b-9' })).toMatchObject({
      code: 'NOT_LINKED',
      message: 'b-9 is not linked to shipped (it links b-1, b-2)',
    });
    expect(await decide({ decision: 'delete' })).toMatchObject({ code: 'INVALID' });
    expect(await decide({ reason: '  ' })).toMatchObject({ code: 'REASON_REQUIRED' });
    expect(await decide({ planId: 'plan/none' })).toMatchObject({ code: 'PLAN_NOT_FOUND' });
  });

  test('events out of step are anomalies, not state changes', async () => {
    const { store, decisions } = await setup();
    await store.append({ type: 'decision-applied', decisionId: 'e_none', note: 'x' }, 'me');
    const state = foldLog(await store.events());
    expect(state.anomalies.map((a) => a.code)).toEqual(['DECISION_OUT_OF_STEP']);
    expect(await decisions()).toEqual([]);
  });

  test('the page shows a proposal, a failure to retry, and activity as sentences', async () => {
    const { store, decide } = await setup();
    const bd = tracker({ 'b-1': 'open', 'b-2': 'open' });
    await decide({ actor: 'claude', finalize: false });
    await decide({ item: 'b-2' });
    bd.failNext('bd is down');
    await applyDecisions({ store, worklink: bd.port, actor: 'me' });
    const content = projectReview({
      events: await store.events(),
      planId: 'plan/d',
      checks: [],
      now: Date.now(),
      mode: 'read',
      you: 'me',
    });
    expect(content?.sections[0]?.flags).toEqual([
      {
        text: 'claude proposes: close b-1. “every claim holds”',
        intent: 'primary',
        buttons: [
          { action: 'decide', label: 'Close b-1', item: 'b-1', decision: 'close', primary: true },
        ],
      },
      {
        text: 'Could not close b-2: bd is down',
        intent: 'danger',
        buttons: [
          { action: 'decide', label: 'Try again', item: 'b-2', decision: 'close', primary: true },
        ],
      },
    ]);
    const [a, b, c] = content?.activity ?? [];
    expect([a?.what, b?.what, c?.what]).toEqual([
      'could not close b-2: bd is down',
      'decided to close b-2: every claim holds',
      'proposed to close b-1: every claim holds',
    ]);
  });
});
