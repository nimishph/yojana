import { createHash } from 'node:crypto';
import type { Annotation, Change, PlanStatus, Requirement } from './model.ts';
import type { RequirementId, RevisionHash } from './revision.ts';

/**
 * The revision log. It is append-only and is the source of truth: plan files are where people
 * edit, and every current state can be rebuilt by folding these events in order.
 */
export type YojanaEventInput =
  | {
      readonly type: 'revision-recorded';
      readonly planId: string;
      readonly requirement: Requirement;
      readonly base?: RevisionHash | undefined;
    }
  | {
      readonly type: 'requirement-removed';
      readonly planId: string;
      readonly id: RequirementId;
      readonly base: RevisionHash;
    }
  | { readonly type: 'change-opened'; readonly change: Change }
  | { readonly type: 'change-archived'; readonly changeId: string }
  | { readonly type: 'change-abandoned'; readonly changeId: string; readonly reason: string }
  | {
      readonly type: 'status-changed';
      readonly planId: string;
      readonly to: PlanStatus;
      readonly reason: string;
    }
  | { readonly type: 'annotation-added'; readonly planId: string; readonly annotation: Annotation }
  | {
      /** The plan's work items (bead ids), as the plan file lists them. */
      readonly type: 'work-linked';
      readonly planId: string;
      readonly workItems: readonly string[];
    }
  /**
   * A decision about a work item (close it, reopen it), asked for on a requirement. Recording is
   * not acting: a decision is applied to the tracker only once it is finalized, so an agent can
   * propose and a person decides. Its id is this event's `eventId`.
   */
  | {
      readonly type: 'decision-recorded';
      readonly planId: string;
      readonly requirement: RequirementId;
      readonly item: string;
      readonly decision: WorkDecision;
      readonly reason: string;
    }
  | { readonly type: 'decision-finalized'; readonly decisionId: string }
  /** The tracker did it, or the item was already that way. */
  | { readonly type: 'decision-applied'; readonly decisionId: string; readonly note: string }
  /** The tracker refused or could not be reached; applying again retries. */
  | { readonly type: 'decision-failed'; readonly decisionId: string; readonly error: string };

/** What a decision does to a work item. */
export type WorkDecision = 'close' | 'reopen';
export const WORK_DECISIONS: readonly WorkDecision[] = ['close', 'reopen'];

export type YojanaEvent = YojanaEventInput & {
  /**
   * Content id, fixed when the event is written. Identity does not depend on position, so logs
   * from two git branches can be merged line by line (merge=union) and still be told apart.
   */
  readonly eventId: string;
  /**
   * Position in this log, from 1. Derived when the log is read, never trusted from storage: after
   * a merge the same event can sit at a different position than where it was written.
   */
  readonly seq: number;
  readonly at: number;
  readonly actor: string;
};

/** Format width of an event id: 64 bits of sha256, ample for one repository's history. */
const EVENT_ID_HEX_CHARS = 16;

/**
 * The id of an event: a hash of its content, its time, who wrote it and, for an event being
 * written, the position it is written at. The position keeps apart the same event written twice by
 * the same actor within one millisecond; it is hashed once and stored, never recomputed from where
 * the event sits later. Without it, the id is the one computed for a line stored before ids were.
 */
export function computeEventId(
  event: YojanaEventInput,
  at: number,
  actor: string,
  writtenAt?: number,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ event, at, actor, writtenAt }))
    .digest('hex');
  return `e_${digest.slice(0, EVENT_ID_HEX_CHARS)}`;
}
