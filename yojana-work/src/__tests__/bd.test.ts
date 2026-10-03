import { describe, expect, test } from 'bun:test';
import { YojanaError } from '@cntxt-labs/yojana-core';
import { type BdRunner, BdWorkLink } from '../bd.ts';

// Shapes copied from bd 1.3.0 (`--json`).
const shown = [
  {
    id: 'anv-yp2',
    title: 'Ship anvesa as a Claude Code plugin',
    status: 'open',
    issue_type: 'epic',
  },
  { id: 'anv-yp2.3', title: 'Add plugin.json', status: 'in_progress', issue_type: 'feature' },
];
const noneFound = {
  error: 'no issues found matching the provided IDs',
  hint: "try 'bd history <id>' to check",
};

function runner(stdout: unknown, seen: string[][] = []): BdRunner {
  return async (args) => {
    seen.push([...args]);
    return { exitCode: 0, stdout: JSON.stringify(stdout), stderr: '' };
  };
}

describe('BdWorkLink.get', () => {
  test('maps bd states and keeps the order asked for', async () => {
    const seen: string[][] = [];
    const lookup = await new BdWorkLink(runner(shown, seen)).get(['anv-yp2.3', 'anv-yp2']);
    expect(seen[0]).toEqual(['show', 'anv-yp2.3', 'anv-yp2', '--json']);
    expect(lookup).toEqual({
      ok: true,
      items: [
        {
          id: 'anv-yp2.3',
          title: 'Add plugin.json',
          state: 'in-progress',
          rawState: 'in_progress',
        },
        {
          id: 'anv-yp2',
          title: 'Ship anvesa as a Claude Code plugin',
          state: 'open',
          rawState: 'open',
        },
      ],
    });
  });

  test('ids bd leaves out come back missing; none found means all missing', async () => {
    const partial = await new BdWorkLink(runner(shown)).get(['anv-yp2', 'anv-typo']);
    expect(partial.ok && partial.items.map((i) => [i.id, i.state])).toEqual([
      ['anv-yp2', 'open'],
      ['anv-typo', 'missing'],
    ]);
    const none = await new BdWorkLink(runner(noneFound)).get(['x-1']);
    expect(none.ok && none.items.map((i) => i.state)).toEqual(['missing']);
  });

  test('a state bd has that yojana does not know is kept as unknown', async () => {
    const odd = [{ id: 'a-1', title: 't', status: 'pinned' }];
    const lookup = await new BdWorkLink(runner(odd)).get(['a-1']);
    expect(lookup.ok && lookup.items[0]).toMatchObject({ state: 'unknown', rawState: 'pinned' });
  });

  test('no ids asks nothing', async () => {
    const seen: string[][] = [];
    expect(await new BdWorkLink(runner(shown, seen)).get([])).toEqual({ ok: true, items: [] });
    expect(seen).toEqual([]);
  });

  test('bd missing, or not answering in JSON, is an error, not an empty list', async () => {
    const absent: BdRunner = async () => {
      throw new YojanaError('TEST_SPAWN', 'Executable not found in $PATH: "bd"');
    };
    expect(await new BdWorkLink(absent).get(['a'])).toMatchObject({
      ok: false,
      error: expect.stringContaining('set BD_BIN'),
    });
    const noDb: BdRunner = async () => ({ exitCode: 1, stdout: '', stderr: 'no .beads found' });
    expect(await new BdWorkLink(noDb).get(['a'])).toMatchObject({
      ok: false,
      error: 'bd did not answer in JSON (exit 1): no .beads found',
    });
    expect(await new BdWorkLink(runner({ odd: true })).get(['a'])).toMatchObject({ ok: false });
  });
});

describe('BdWorkLink.children', () => {
  test('lists every child, closed ones included', async () => {
    const seen: string[][] = [];
    const kids = [
      { id: 'e.1', title: 'a', status: 'closed' },
      { id: 'e.2', title: 'b', status: 'open' },
    ];
    const lookup = await new BdWorkLink(runner(kids, seen)).children('e');
    expect(seen[0]).toEqual(['list', '--parent', 'e', '--all', '--json', '--limit', '0']);
    expect(lookup.ok && lookup.items.map((i) => i.state)).toEqual(['closed', 'open']);
  });
});
