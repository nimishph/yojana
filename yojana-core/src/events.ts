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
  | { readonly type: 'annotation-added'; readonly planId: string; readonly annotation: Annotation };

export type YojanaEvent = YojanaEventInput & {
  /** Store-assigned, monotonic within one log. */
  readonly seq: number;
  readonly at: number;
  readonly actor: string;
};
