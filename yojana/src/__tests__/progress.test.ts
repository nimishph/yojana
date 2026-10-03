import { describe, expect, test } from 'bun:test';
import type { WorkItem, WorkLinkPort } from '@cntxt-labs/yojana-core';
import { MarkdownParser } from '@cntxt-labs/yojana-markdown';
import { MemoryBaseStore, MemoryStore } from '@cntxt-labs/yojana-store';
import { ingest } from '../ingest.ts';
import { progress } from '../progress.ts';

const item = (id: string, state: WorkItem['state']): WorkItem => ({ id, title: id, state });

/** A tracker with one epic of three tasks (one closed) and a standalone closed bug. */
const tracker: WorkLinkPort = {
  name: 'fake',
  async get(ids) {
    const known = new Map([
      ['epic', item('epic', 'open')],
      ['bug', item('bug', 'closed')],
    ]);
    return { ok: true, items: ids.map((id) => known.get(id) ?? item(id, 'missing')) };
  },
  async children(id) {
    const kids =
      id === 'epic'
        ? [item('epic.1', 'closed'), item('epic.2', 'open'), item('epic.3', 'in-progress')]
        : [];
    return { ok: true, items: kids };
  },
};

async function storeWith(beads: string) {
  const store = new MemoryStore();
  await store.open();
  const bases = new MemoryBaseStore();
  const run = (list: string) =>
    ingest({
      store,
      parser: new MarkdownParser(),
      bases,
      files: [{ source: 'p.md', text: `---\nid: plan/p\nbeads: [${list}]\n---\n` }],
      actor: 'me',
    });
  await run(beads);
  return { store, run };
}

describe('ingest records the work items', () => {
  test('a changed list is one work-linked event; reordering is not a change', async () => {
    const { store, run } = await storeWith('epic');
    expect((await store.events()).filter((e) => e.type === 'work-linked')).toHaveLength(1);
    expect((await run('epic, bug')).appended).toBe(1);
    expect((await run('bug, epic')).appended).toBe(0);
  });
});

describe('progress', () => {
  test('an epic counts its children; a plain item counts itself', async () => {
    const { store } = await storeWith('epic, bug');
    const [plan] = await progress({ store, worklink: tracker });
    expect(plan).toMatchObject({ planId: 'plan/p', done: 2, total: 4, error: undefined });
    expect(plan?.items.map((p) => [p.item.id, p.children.length])).toEqual([
      ['epic', 3],
      ['bug', 0],
    ]);
  });

  test('a missing item is listed and counts as not done', async () => {
    const { store } = await storeWith('bug, typo-1');
    const [plan] = await progress({ store, worklink: tracker });
    expect(plan).toMatchObject({ done: 1, total: 2 });
    expect(plan?.items[1]?.item.state).toBe('missing');
  });

  test('a tracker that cannot be asked is an error, not zero progress', async () => {
    const { store } = await storeWith('epic');
    const down: WorkLinkPort = {
      name: 'down',
      get: async () => ({ ok: false, error: 'bd not installed' }),
      children: async () => ({ ok: false, error: 'bd not installed' }),
    };
    const [plan] = await progress({ store, worklink: down });
    expect(plan).toMatchObject({ error: 'bd not installed', items: [] });
  });
});
