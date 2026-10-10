import { describe, expect, test } from 'bun:test';
import type { WorkItem, WorkLinkPort, WorkLookup } from '@cntxt-labs/yojana-core';
import { CompositeWorkLink, createWorkLink } from '../composite.ts';

function mockAdapter(
  name: string,
  items: Record<string, WorkItem['state']>,
  childrenMap: Record<string, string[]> = {},
): WorkLinkPort {
  return {
    name,
    async get(ids: readonly string[]): Promise<WorkLookup> {
      return {
        ok: true,
        items: ids.map((id) => {
          const st = items[id];
          return st !== undefined
            ? { id, title: `${name}:${id}`, state: st }
            : { id, title: '', state: 'missing' };
        }),
      };
    },
    async children(id: string): Promise<WorkLookup> {
      const kids = childrenMap[id] ?? [];
      return {
        ok: true,
        items: kids.map((kid) => ({
          id: kid,
          title: `${name}:${kid}`,
          state: items[kid] ?? 'open',
        })),
      };
    },
    async close(id: string) {
      if (items[id] !== undefined) {
        items[id] = 'closed';
        return { ok: true as const };
      }
      return { ok: false as const, error: `${name} has no ${id}` };
    },
    async reopen(id: string) {
      if (items[id] !== undefined) {
        items[id] = 'open';
        return { ok: true as const };
      }
      return { ok: false as const, error: `${name} has no ${id}` };
    },
    async create(_options) {
      const newId = `${name}-new`;
      items[newId] = 'open';
      return { ok: true as const, id: newId };
    },
  };
}

describe('CompositeWorkLink', () => {
  test('routes IDs by shape and combines in requested order', async () => {
    const bd = mockAdapter('bd', { 'yoj-100': 'open' });
    const github = mockAdapter('github', { '#42': 'closed', '105': 'open' });
    const checklist = mockAdapter('checklist', { 'req-auth': 'in-progress', 'act-jwt': 'open' });

    const composite = new CompositeWorkLink({
      adapters: { bd, github, checklist },
    });

    const lookup = await composite.get(['#42', 'yoj-100', 'req-auth', '105', 'nonexistent']);
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;

    expect(lookup.items).toEqual([
      { id: '#42', title: 'github:#42', state: 'closed' },
      { id: 'yoj-100', title: 'bd:yoj-100', state: 'open' },
      { id: 'req-auth', title: 'checklist:req-auth', state: 'in-progress' },
      { id: '105', title: 'github:105', state: 'open' },
      { id: 'nonexistent', title: '', state: 'missing' },
    ]);
  });

  test('routes children and mutations to matching adapter', async () => {
    const bd = mockAdapter(
      'bd',
      { 'yoj-epic': 'open', 'yoj-epic.1': 'open' },
      {
        'yoj-epic': ['yoj-epic.1'],
      },
    );
    const github = mockAdapter('github', { '#99': 'open' });
    const checklist = mockAdapter('checklist', { 'req-1': 'open' });

    const composite = new CompositeWorkLink({
      adapters: { bd, github, checklist },
    });

    const kids = await composite.children('yoj-epic');
    expect(kids).toEqual({
      ok: true,
      items: [{ id: 'yoj-epic.1', title: 'bd:yoj-epic.1', state: 'open' }],
    });

    expect(await composite.close('#99', 'done')).toEqual({ ok: true });
    expect(await composite.reopen('#99', 'reopen')).toEqual({ ok: true });

    const created = await composite.create({ title: 'New bead', parent: 'yoj-epic' });
    expect(created).toEqual({ ok: true, id: 'bd-new' });
  });

  test('createWorkLink returns requested adapter type', () => {
    const bd = createWorkLink({ type: 'bd' });
    expect(bd.name).toBe('bd');

    const gh = createWorkLink({ type: 'github' });
    expect(gh.name).toBe('github');

    const cl = createWorkLink({ type: 'checklist' });
    expect(cl.name).toBe('checklist');

    const comp = createWorkLink({ type: 'composite' });
    expect(comp.name).toBe('composite');
  });
});
