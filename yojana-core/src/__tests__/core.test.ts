import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { findBaseConflicts } from '../conflicts.ts';
import { computeEventId, type YojanaEventInput } from '../events.ts';
import { type Requirement, requirementWorkItems } from '../model.ts';
import { actionsRevision, assertActionId, assertRequirementId, revisionHash } from '../revision.ts';

const req = (id: string, text: string): Requirement => ({
  id,
  title: id,
  text,
  revision: revisionHash(id, text),
  claims: [],
});

describe('computeEventId', () => {
  const event: YojanaEventInput = {
    type: 'status-changed',
    planId: 'p',
    to: 'accepted',
    reason: 'r',
  };

  test('without a write position, the id of a line stored before ids is unchanged', () => {
    const legacy = createHash('sha256')
      .update(JSON.stringify({ event, at: 5, actor: 'old' }))
      .digest('hex');
    expect(`e_${legacy}`).toStartWith(computeEventId(event, 5, 'old'));
  });

  test('the write position keeps apart one event written twice in a millisecond', () => {
    expect(computeEventId(event, 5, 'a', 1)).not.toBe(computeEventId(event, 5, 'a', 2));
  });
});

describe('revisionHash', () => {
  test('ignores line endings and trailing whitespace', () => {
    expect(revisionHash('a', 'one\r\ntwo  \n\n')).toBe(revisionHash('a', 'one\ntwo'));
  });

  test('differs by id and by text', () => {
    expect(revisionHash('a', 'x')).not.toBe(revisionHash('b', 'x'));
    expect(revisionHash('a', 'x')).not.toBe(revisionHash('a', 'y'));
  });
});

describe('assertRequirementId', () => {
  test('accepts kebab-case and rejects anything else', () => {
    expect(assertRequirementId('req-no-global')).toBe('req-no-global');
    expect(() => assertRequirementId('Has Space')).toThrow();
  });
});

describe('assertActionId', () => {
  test('accepts kebab-case starting with act- and rejects anything else', () => {
    expect(assertActionId('act-npx')).toBe('act-npx');
    expect(assertActionId('act-do-something-123')).toBe('act-do-something-123');
    expect(() => assertActionId('npx')).toThrow();
    expect(() => assertActionId('act-')).toThrow();
    expect(() => assertActionId('act-Has Space')).toThrow();
  });
});

describe('actionsRevision and requirementWorkItems', () => {
  test('actionsRevision is deterministic and changes when actions change', () => {
    const act1 = { id: 'act-1', text: 'Do first', workItems: ['b1'] };
    const act2 = { id: 'act-2', text: 'Do second' };
    const rev1 = actionsRevision('req-1', [act1, act2]);
    const rev2 = actionsRevision('req-1', [act1, act2]);
    expect(rev1).toBe(rev2);

    const revModified = actionsRevision('req-1', [{ ...act1, text: 'Do first modified' }, act2]);
    expect(revModified).not.toBe(rev1);

    const revDiffWork = actionsRevision('req-1', [{ ...act1, workItems: ['b2'] }, act2]);
    expect(revDiffWork).not.toBe(rev1);
  });

  test('requirementWorkItems computes union of requirement and action beads', () => {
    const requirement: Requirement = {
      id: 'req-1',
      title: 'Req 1',
      text: 'Prose',
      revision: 'r_123',
      claims: [],
      workItems: ['b1', 'b2'],
      actions: [
        { id: 'act-1', text: 'Action 1', workItems: ['b2', 'b3'] },
        { id: 'act-2', text: 'Action 2', workItems: ['b4'] },
      ],
    };
    expect(requirementWorkItems(requirement)).toEqual(['b1', 'b2', 'b3', 'b4']);
  });
});

describe('findBaseConflicts', () => {
  const v1 = req('r1', 'first');
  const v2 = req('r1', 'second');
  const heads = new Map([[v1.id, v1.revision]]);

  test('a modify written against the current revision applies', () => {
    expect(
      findBaseConflicts(heads, [{ op: 'modify', requirement: v2, base: v1.revision }]),
    ).toEqual([]);
  });

  test('a modify written against a stale revision conflicts', () => {
    const moved = new Map([[v1.id, v2.revision]]);
    expect(
      findBaseConflicts(moved, [{ op: 'modify', requirement: v2, base: v1.revision }]),
    ).toEqual([{ requirement: 'r1', op: 'modify', expected: v1.revision, actual: v2.revision }]);
  });

  test('adding an existing id or removing a missing one conflicts', () => {
    expect(findBaseConflicts(heads, [{ op: 'add', requirement: v1 }])).toHaveLength(1);
    expect(
      findBaseConflicts(new Map(), [{ op: 'remove', id: 'r1', base: v1.revision }]),
    ).toHaveLength(1);
  });
});
