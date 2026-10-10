import type { Claim } from './predicate.ts';
import type { ActionId, RequirementId, RevisionHash } from './revision.ts';

export type { Claim, ClaimPredicate, ScalarPredicate } from './predicate.ts';
export type { ActionId } from './revision.ts';

/** Lifecycle of a plan. Every transition is an event with a reason. */
export type PlanStatus =
  | 'draft'
  | 'accepted'
  | 'in-progress'
  | 'realized'
  | 'superseded'
  | 'abandoned';

/**
 * An action item under a requirement describing concrete work to deliver it.
 * Bead links indicate tracker items; claims specify done-when checks.
 */
export interface Action {
  readonly id: ActionId;
  readonly text: string;
  readonly workItems?: readonly string[] | undefined;
  readonly claims?: readonly Claim[] | undefined;
}

export interface Requirement {
  readonly id: RequirementId;
  readonly title: string;
  readonly text: string;
  readonly revision: RevisionHash;
  readonly claims: readonly Claim[];
  /** Actions that deliver this requirement; absent in logs written before actions. */
  readonly actions?: readonly Action[] | undefined;
  /** Revision of the actions list, separate from the requirement's revision. */
  readonly actionsRevision?: RevisionHash | undefined;
  /** Work items (bead ids) that deliver this requirement; absent in logs written before links. */
  readonly workItems?: readonly string[] | undefined;
}

/**
 * All work items delivering a requirement: the union of requirement-level beads
 * and beads linked to individual actions.
 */
export function requirementWorkItems(requirement: Requirement): readonly string[] {
  const reqWork = requirement.workItems ?? [];
  const actWork = (requirement.actions ?? []).flatMap((a) => a.workItems ?? []);
  return [...new Set([...reqWork, ...actWork])];
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
  /** The change file it was opened from, when there was one. */
  readonly source?: string | undefined;
}

/**
 * A change as written in a change file: what it does, before it is opened. Opening pins every
 * modify and remove to the requirement's revision in the log at that moment, making it a Change.
 */
export type DeltaDraft =
  | { readonly op: 'add'; readonly requirement: Requirement }
  | { readonly op: 'modify'; readonly requirement: Requirement }
  | { readonly op: 'remove'; readonly id: RequirementId };

export interface ChangeDraft {
  readonly id: string;
  readonly planId: string;
  readonly title: string;
  readonly deltas: readonly DeltaDraft[];
  readonly source: string;
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
