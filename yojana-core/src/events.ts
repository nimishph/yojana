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
    };

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

/** The id of an event: a hash of its content, its time and who wrote it. */
export function computeEventId(event: YojanaEventInput, at: number, actor: string): string {
  const digest = createHash('sha256').update(JSON.stringify({ event, at, actor })).digest('hex');
  return `e_${digest.slice(0, EVENT_ID_HEX_CHARS)}`;
}
