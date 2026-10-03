import { createHash } from 'node:crypto';
import { InvalidArgumentError } from './errors.ts';

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
  readonly claims: readonly {
    readonly kind: string;
    readonly expression: string;
    readonly expect: boolean;
  }[];
}): RevisionHash {
  const { id, title, text, claims } = requirement;
  const claimLines = claims.map((c) => `claim ${c.kind} ${c.expect} ${c.expression.trim()}`);
  return revisionHash(
    id,
    [`title ${title.trim()}`, normalizeContent(text), ...claimLines].join('\n'),
  );
}

export function revisionHash(id: RequirementId, text: string): RevisionHash {
  const digest = createHash('sha256')
    .update(`${id}\n${normalizeContent(text)}`)
    .digest('hex');
  return `r_${digest.slice(0, REVISION_HEX_CHARS)}`;
}
