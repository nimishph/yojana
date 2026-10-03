import { describe, expect, test } from 'bun:test';
import { findBaseConflicts } from '../conflicts.ts';
import type { Requirement } from '../model.ts';
import { assertRequirementId, revisionHash } from '../revision.ts';

const req = (id: string, text: string): Requirement => ({
  id,
  title: id,
  text,
  revision: revisionHash(id, text),
  claims: [],
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
