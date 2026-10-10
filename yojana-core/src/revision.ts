import { createHash } from 'node:crypto';
import { InvalidArgumentError } from './errors.ts';
import type { Claim } from './predicate.ts';

/**
 * Requirement identity and revisions.
 *
 * A requirement has a stable id (`req-no-global`) chosen by its author and never reused. Each
 * version of its text is a revision, identified by the hash of its normalised content, so the
 * same text always has the same revision whichever machine or adapter recorded it.
 */

export type RequirementId = string;
export type RevisionHash = string;

const REQUIREMENT_ID = /^[a-z][a-z0-9-]{0,63}$/;

export function assertRequirementId(id: string): RequirementId {
  if (!REQUIREMENT_ID.test(id)) {
    throw new InvalidArgumentError('requirement id', 'lowercase kebab-case, 1-64 chars', id);
  }
  return id;
}

const CHANGE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Change ids name a file and an archive entry, so they follow the same kebab-case rule. */
export function assertChangeId(id: string): string {
  if (!CHANGE_ID.test(id)) {
    throw new InvalidArgumentError('change id', 'lowercase kebab-case, 1-64 chars', id);
  }
  return id;
}

export type ActionId = string;

const ACTION_ID = /^act-[a-z0-9-]{1,60}$/;

/** Action ids start with act- followed by lowercase kebab-case. */
export function assertActionId(id: string): ActionId {
  if (!ACTION_ID.test(id)) {
    throw new InvalidArgumentError(
      'action id',
      'lowercase kebab-case starting with act-, 5-64 chars',
      id,
    );
  }
  return id;
}

/**
 * Normalise text before hashing: line endings, trailing whitespace and surrounding blank lines
 * do not change meaning, so they do not change the revision.
 */
export function normalizeContent(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

/**
 * Format width of a revision: 64 bits of the sha256. Revisions are compared within one
 * requirement's history, so collisions are not a practical concern, and short ids stay readable
 * in plan files and diffs.
 */
const REVISION_HEX_CHARS = 16;

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    sorted[k] = sortKeys(obj[k]);
  }
  return sorted;
}

/**
 * Canonical serialization of a claim for revision hashing.
 * Preserves legacy string format for shorthand claims {kind, expression, expect: bool}
 * and deterministically hashes structured params/predicates.
 */
export function canonicalClaim(claim: Claim): string {
  if (
    claim.expression !== undefined &&
    typeof claim.expect === 'boolean' &&
    (claim.params === undefined || Object.keys(claim.params).length === 0) &&
    (claim.claims === undefined || claim.claims.length === 0)
  ) {
    return `claim ${claim.kind} ${claim.expect} ${claim.expression.trim()}`;
  }
  const parts = [`claim ${claim.kind}`];
  if (claim.expression !== undefined && claim.expression.trim() !== '') {
    parts.push(`expr:${claim.expression.trim()}`);
  }
  if (claim.params !== undefined && Object.keys(claim.params).length > 0) {
    parts.push(`params:${JSON.stringify(sortKeys(claim.params))}`);
  }
  if (claim.claims !== undefined && claim.claims.length > 0) {
    parts.push(`claims:[${claim.claims.map(canonicalClaim).join(',')}]`);
  }
  parts.push(
    `expect:${typeof claim.expect === 'object' && claim.expect !== null ? JSON.stringify(sortKeys(claim.expect)) : claim.expect}`,
  );
  return parts.join(' ');
}

/**
 * The revision of a requirement: everything about it except its id. Title, prose and claims all
 * count, since renaming a requirement or changing what it checks changes the requirement. Every
 * parser computes revisions through this, so the same requirement has the same revision whatever
 * file format it was read from.
 */
export function requirementRevision(requirement: {
  readonly id: RequirementId;
  readonly title: string;
  readonly text: string;
  readonly claims: readonly Claim[];
  readonly workItems?: readonly string[] | undefined;
}): RevisionHash {
  const { id, title, text, claims } = requirement;
  const claimLines = claims.map(canonicalClaim);
  // Only present when linked, so a requirement without links keeps the revision it always had.
  const work = [...(requirement.workItems ?? [])].sort();
  const workLines = work.length > 0 ? [`work ${work.join(',')}`] : [];
  return revisionHash(
    id,
    [`title ${title.trim()}`, normalizeContent(text), ...claimLines, ...workLines].join('\n'),
  );
}

export function revisionHash(id: RequirementId, text: string): RevisionHash {
  const digest = createHash('sha256')
    .update(`${id}\n${normalizeContent(text)}`)
    .digest('hex');
  return `r_${digest.slice(0, REVISION_HEX_CHARS)}`;
}

/**
 * The revision of a requirement's actions: separate from the requirement's revision, so
 * re-planning actions does not count as changing the requirement itself.
 */
export function actionsRevision(
  id: RequirementId,
  actions: readonly {
    readonly id: ActionId;
    readonly text: string;
    readonly workItems?: readonly string[] | undefined;
    readonly claims?: readonly Claim[] | undefined;
  }[],
): RevisionHash {
  const lines = actions.map((a) => {
    const work = [...(a.workItems ?? [])].sort();
    const workPart = work.length > 0 ? ` work ${work.join(',')}` : '';
    const claims = a.claims ?? [];
    const claimParts = claims.map((c) => ` ${canonicalClaim(c)}`).join('');
    return `action ${a.id} ${normalizeContent(a.text)}${workPart}${claimParts}`;
  });
  return revisionHash(id, `actions\n${lines.join('\n')}`);
}
