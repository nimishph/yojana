import type { RequirementId, RevisionHash } from './revision.ts';

/** Lifecycle of a plan. Every transition is an event with a reason. */
export type PlanStatus =
  | 'draft'
  | 'accepted'
  | 'in-progress'
  | 'realized'
  | 'superseded'
  | 'abandoned';

/**
 * A checkable statement about the code. `kind` names the verifier that understands it
 * (`wql` and `dependents` for anvesa, `command` for a shell fallback).
 */
export interface Claim {
  readonly kind: string;
  readonly expression: string;
  /** true: the expression must match something; false: it must match nothing. */
  readonly expect: boolean;
}

export interface Requirement {
  readonly id: RequirementId;
  readonly title: string;
  readonly text: string;
  readonly revision: RevisionHash;
  readonly claims: readonly Claim[];
}

export const PLAN_STATUSES: readonly PlanStatus[] = [
  'draft',
  'accepted',
  'in-progress',
  'realized',
  'superseded',
  'abandoned',
];

/**
 * The plan's document order: free prose (context, design notes) interleaved with requirements.
 * Prose is kept verbatim so rendering a plan gives back the document its author wrote.
 */
export type PlanPart =
  | { readonly kind: 'prose'; readonly markdown: string }
  | { readonly kind: 'requirement'; readonly id: RequirementId };

export interface Plan {
  readonly id: string;
  readonly title: string;
  readonly status: PlanStatus;
  /** Work items in the tracker (bead ids). Progress is derived from them, never typed in. */
  readonly workItems: readonly string[];
  readonly requirements: readonly Requirement[];
  readonly parts: readonly PlanPart[];
  /** Where the plan was read from; adapter-specific (a file path for Markdown). */
  readonly source: string;
}

/**
 * One edit a change makes to one requirement, recorded against the revision it started from.
 * `base` is absent only for an added requirement.
 */
export type Delta =
  | { readonly op: 'add'; readonly requirement: Requirement; readonly base?: undefined }
  | { readonly op: 'modify'; readonly requirement: Requirement; readonly base: RevisionHash }
  | { readonly op: 'remove'; readonly id: RequirementId; readonly base: RevisionHash };

export interface Change {
  readonly id: string;
  readonly planId: string;
  readonly title: string;
  readonly deltas: readonly Delta[];
}

/**
 * A review comment or highlight anchored to a requirement revision, so it survives edits to
 * other requirements and is flagged as outdated when its own requirement changes.
 */
export interface Annotation {
  readonly id: string;
  readonly requirement: RequirementId;
  readonly revision: RevisionHash;
  readonly author: string;
  readonly body: string;
  /** Optional quoted span inside the requirement text that the comment highlights. */
  readonly quote?: string | undefined;
  readonly replyTo?: string | undefined;
}
