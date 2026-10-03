import type { Delta } from './model.ts';
import type { RequirementId, RevisionHash } from './revision.ts';

export interface BaseConflict {
  readonly requirement: RequirementId;
  readonly op: Delta['op'];
  /** The revision the change was written against (undefined for an add). */
  readonly expected: RevisionHash | undefined;
  /** The revision the log holds now (undefined when the requirement does not exist). */
  readonly actual: RevisionHash | undefined;
}

/**
 * Optimistic concurrency for archive: every delta must still apply to the revision it was written
 * against. An add conflicts when the id already exists; a modify or remove conflicts when the
 * requirement has moved on or is gone. An empty result means the change can be archived.
 */
export function findBaseConflicts(
  heads: ReadonlyMap<RequirementId, RevisionHash>,
  deltas: readonly Delta[],
): BaseConflict[] {
  const conflicts: BaseConflict[] = [];
  for (const delta of deltas) {
    const id = delta.op === 'remove' ? delta.id : delta.requirement.id;
    const actual = heads.get(id);
    const expected = delta.base;
    const ok = delta.op === 'add' ? actual === undefined : actual === expected;
    if (!ok) conflicts.push({ requirement: id, op: delta.op, expected, actual });
  }
  return conflicts;
}
