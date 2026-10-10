import { describe, expect, test } from 'bun:test';
import { YojanaError } from '@cntxt-labs/yojana-core';
import { type GhRunner, GhWorkLink } from '../gh.ts';

function runner(
  responses: Record<string, string | { exitCode?: number; stdout?: string; stderr?: string }>,
  seen: string[][] = [],
): GhRunner {
  return async (args) => {
    seen.push([...args]);
    const key = args.join(' ');
    // Match exact key or prefix match
    const foundKey = Object.keys(responses).find((k) => key.includes(k));
    if (foundKey !== undefined) {
      const resp = responses[foundKey];
      if (resp !== undefined) {
        if (typeof resp === 'string') {
          return { exitCode: 0, stdout: resp, stderr: '' };
        }
        return {
          exitCode: resp.exitCode ?? 0,
          stdout: resp.stdout ?? '',
          stderr: resp.stderr ?? '',
        };
      }
    }
    return { exitCode: 1, stdout: '', stderr: 'GraphQL: Could not resolve to an issue' };
  };
}

describe('GhWorkLink.get', () => {
  test('maps GitHub issue states and preserves order of requested ids', async () => {
    const seen: string[][] = [];
    const gh = new GhWorkLink(
      runner(
        {
          'issue view 101': JSON.stringify({
            number: 101,
            title: 'Fix auth session leak',
            state: 'OPEN',
            stateReason: null,
          }),
          'issue view 102': JSON.stringify({
            number: 102,
            title: 'Refactor store to SQLite',
            state: 'CLOSED',
            stateReason: 'COMPLETED',
          }),
          'issue view 103': JSON.stringify({
            number: 103,
            title: 'Deprecated legacy format',
            state: 'CLOSED',
            stateReason: 'NOT_PLANNED',
          }),
        },
        seen,
      ),
      { repo: 'my-org/my-repo' },
    );

    const lookup = await gh.get(['#101', '102', 'gh#103']);
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;

    expect(lookup.items).toEqual([
      { id: '#101', title: 'Fix auth session leak', state: 'open', rawState: 'OPEN' },
      { id: '102', title: 'Refactor store to SQLite', state: 'closed', rawState: 'CLOSED' },
      { id: 'gh#103', title: 'Deprecated legacy format', state: 'deferred', rawState: 'CLOSED' },
    ]);

    // Verified that -R was passed
    expect(seen[0]).toContain('-R');
    expect(seen[0]).toContain('my-org/my-repo');
  });

  test('unrecognized states are marked unknown', async () => {
    const gh = new GhWorkLink(
      runner({
        'issue view 10': JSON.stringify({
          number: 10,
          title: 'Weird state',
          state: 'TRIAGED',
        }),
      }),
    );

    const lookup = await gh.get(['#10']);
    expect(lookup).toEqual({
      ok: true,
      items: [{ id: '#10', title: 'Weird state', state: 'unknown', rawState: 'TRIAGED' }],
    });
  });

  test('not found issues come back as missing', async () => {
    const gh = new GhWorkLink(
      runner({
        'issue view 99': {
          exitCode: 1,
          stderr: 'GraphQL: Could not resolve to an issue with the number of 99.',
        },
      }),
    );

    const lookup = await gh.get(['#99']);
    expect(lookup).toEqual({
      ok: true,
      items: [{ id: '#99', title: '', state: 'missing' }],
    });
  });

  test('empty ids list asks nothing and returns ok', async () => {
    const seen: string[][] = [];
    const gh = new GhWorkLink(runner({}, seen));
    expect(await gh.get([])).toEqual({ ok: true, items: [] });
    expect(seen).toHaveLength(0);
  });

  test('gh missing or throwing is reported as error', async () => {
    const missing = new GhWorkLink(async () => {
      throw new YojanaError('GH_FAILED', 'gh: command not found');
    });
    const result = await missing.get(['#1']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('could not run gh');
    }
  });

  test('gh malformed JSON is reported as error', async () => {
    const broken = new GhWorkLink(
      runner({
        'issue view 1': 'not valid json at all',
      }),
    );
    const result = await broken.get(['#1']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('gh did not answer in JSON');
    }
  });
});

describe('GhWorkLink.children', () => {
  test('lists native subIssues when present', async () => {
    const gh = new GhWorkLink(
      runner({
        'issue view 200': JSON.stringify({
          number: 200,
          title: 'Parent Epic Issue',
          state: 'OPEN',
          subIssues: [
            { number: 201, title: 'Child Task 1', state: 'CLOSED', stateReason: 'COMPLETED' },
            { number: 202, title: 'Child Task 2', state: 'OPEN', stateReason: null },
          ],
        }),
      }),
    );

    const result = await gh.children('200');
    expect(result).toEqual({
      ok: true,
      items: [
        { id: '#201', title: 'Child Task 1', state: 'closed', rawState: 'CLOSED' },
        { id: '#202', title: 'Child Task 2', state: 'open', rawState: 'OPEN' },
      ],
    });
  });

  test('parses checklist items from issue body when subIssues absent', async () => {
    const gh = new GhWorkLink(
      runner({
        'issue view 300': JSON.stringify({
          number: 300,
          title: 'Epic with body tasklist',
          state: 'OPEN',
          body: `
Here is what we need to deliver:
- [x] #301 Database schema migration
- [ ] #302 API endpoint implementation
- [x] Run test suite
          `,
        }),
      }),
    );

    const result = await gh.children('300');
    expect(result).toEqual({
      ok: true,
      items: [
        { id: '#301', title: 'Database schema migration', state: 'closed', rawState: 'CLOSED' },
        { id: '#302', title: 'API endpoint implementation', state: 'open', rawState: 'OPEN' },
        { id: '300.3', title: 'Run test suite', state: 'closed', rawState: 'CLOSED' },
      ],
    });
  });

  test('returns empty items when issue has no children or checklist', async () => {
    const gh = new GhWorkLink(
      runner({
        'issue view 400': JSON.stringify({
          number: 400,
          title: 'Standalone task',
          state: 'OPEN',
          body: 'Plain text description with no checklists.',
        }),
      }),
    );

    const result = await gh.children('400');
    expect(result).toEqual({
      ok: true,
      items: [],
    });
  });
});

describe('GhWorkLink.close and reopen', () => {
  test('runs gh issue close and reopen with comment and succeeds on exit 0', async () => {
    const seen: string[][] = [];
    const gh = new GhWorkLink(runner({ 'issue close': '', 'issue reopen': '' }, seen));

    expect(await gh.close('101', 'Done in PR #50')).toEqual({ ok: true });
    expect(seen[0]).toEqual(['issue', 'close', '101', '--comment', 'Done in PR #50']);

    expect(await gh.reopen('#101', 'Reopening for bug fix')).toEqual({ ok: true });
    expect(seen[1]).toEqual(['issue', 'reopen', '101', '--comment', 'Reopening for bug fix']);
  });

  test('reports errors on failure', async () => {
    const gh = new GhWorkLink(
      runner({
        'issue close': { exitCode: 1, stderr: 'GraphQL: permission denied' },
      }),
    );

    const result = await gh.close('55', 'closing');
    expect(result).toEqual({
      ok: false,
      error: 'gh issue close 55 failed (exit 1): GraphQL: permission denied',
    });
  });
});

describe('GhWorkLink.create', () => {
  test('creates issue and parses issue number from returned URL', async () => {
    const seen: string[][] = [];
    const gh = new GhWorkLink(
      runner(
        {
          'issue create': 'https://github.com/my-org/my-repo/issues/789\n',
        },
        seen,
      ),
    );

    const result = await gh.create({
      title: 'New action item',
      description: 'Action description',
      parent: '500',
    });

    expect(result).toEqual({ ok: true, id: '#789' });
    expect(seen[0]).toEqual([
      'issue',
      'create',
      '--title',
      'New action item',
      '--body',
      'Action description',
      '--parent',
      '500',
    ]);
  });

  test('reports error if create fails', async () => {
    const gh = new GhWorkLink(
      runner({
        'issue create': { exitCode: 1, stderr: 'Failed to create issue: title cannot be blank' },
      }),
    );

    const result = await gh.create({ title: '' });
    expect(result).toEqual({
      ok: false,
      error: 'gh issue create failed (exit 1): Failed to create issue: title cannot be blank',
    });
  });
});
