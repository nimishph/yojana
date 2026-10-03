import type { YojanaEvent } from './events.ts';
import type { Annotation, Change, Delta, PlanStatus, Requirement } from './model.ts';
import type { RequirementId, RevisionHash } from './revision.ts';

/**
 * Fold: the current state, rebuilt from the log. The log is the source of truth, so the fold is
 * faithful to it: it applies what was recorded and reports anything inconsistent (a revision
 * recorded on a stale base, archiving a change that is not open, an event type this version
 * does not know) as an anomaly instead of guessing or dropping it.
 *
 * Deterministic: the same events give the same state, and folding in batches gives the same state
 * as folding in one pass.
 */

export interface StatusEntry {
  readonly to: PlanStatus;
  readonly reason: string;
  readonly actor: string;
  readonly at: number;
  readonly seq: number;
}

export interface PlanState {
  readonly id: string;
  status: PlanStatus;
  readonly statusHistory: StatusEntry[];
  /** Current revision of every live requirement, in the order they first appeared. */
  readonly heads: Map<RequirementId, Requirement>;
  /**
   * Requirements edited concurrently: an edit arrived written against a revision that was no
   * longer current (two git branches both edited it, then merged). Maps the id to the competing
   * revisions, in log order; the head is the last one. Cleared by the next edit written against
   * the head, which is how a person settles it.
   */
  readonly contested: Map<RequirementId, (RevisionHash | undefined)[]>;
  readonly annotations: Annotation[];
  /** Work items the plan names, from its latest `work-linked` event. */
  workItems: readonly string[];
}

export type ChangeStatus = 'open' | 'archived' | 'abandoned';

export interface ChangeState {
  readonly change: Change;
  status: ChangeStatus;
  readonly openedSeq: number;
  readonly openedAt: number;
  closedSeq: number | undefined;
  reason: string | undefined;
}

export interface Anomaly {
  readonly seq: number;
  readonly code: string;
  readonly message: string;
  /** For STALE_BASE: the requirement whose edits collided. */
  readonly planId?: string | undefined;
  readonly requirement?: RequirementId | undefined;
  /**
   * For STALE_BASE: the seq of the later edit, written against the head, that settled the
   * collision. A settled anomaly is history, kept in the log but no longer needing attention.
   */
  settledBy?: number | undefined;
}

/** Anomalies that still need attention: everything except settled collisions. */
export function openAnomalies(state: FoldState): Anomaly[] {
  return state.anomalies.filter((a) => a.settledBy === undefined);
}

export interface FoldState {
  readonly plans: Map<string, PlanState>;
  readonly changes: Map<string, ChangeState>;
  readonly anomalies: Anomaly[];
  /** Highest seq folded so far. */
  head: number;
}

export function emptyFoldState(): FoldState {
  return { plans: new Map(), changes: new Map(), anomalies: [], head: 0 };
}

function planFor(state: FoldState, id: string): PlanState {
  let plan = state.plans.get(id);
  if (plan === undefined) {
    plan = {
      id,
      status: 'draft',
      statusHistory: [],
      heads: new Map(),
      contested: new Map(),
      annotations: [],
      workItems: [],
    };
    state.plans.set(id, plan);
  }
  return plan;
}

function applyDelta(state: FoldState, plan: PlanState, delta: Delta, seq: number): void {
  const id = delta.op === 'remove' ? delta.id : delta.requirement.id;
  const actual = plan.heads.get(id)?.revision;
  const stale = delta.op === 'add' ? actual !== undefined : actual !== delta.base;
  const after = delta.op === 'remove' ? undefined : delta.requirement.revision;
  if (stale) {
    const competing = plan.contested.get(id) ?? [actual];
    plan.contested.set(id, [...competing, after]);
  } else if (plan.contested.delete(id)) {
    for (const anomaly of state.anomalies) {
      if (
        anomaly.code === 'STALE_BASE' &&
        anomaly.planId === plan.id &&
        anomaly.requirement === id &&
        anomaly.settledBy === undefined
      ) {
        anomaly.settledBy = seq;
      }
    }
  }
  if (stale) {
    state.anomalies.push({
      seq,
      code: 'STALE_BASE',
      message: `${delta.op} of ${id} in ${plan.id} expected ${delta.base ?? 'no requirement'}, log had ${actual ?? 'none'}`,
      planId: plan.id,
      requirement: id,
    });
  }
  if (delta.op === 'remove') plan.heads.delete(id);
  else plan.heads.set(id, delta.requirement);
}

/** Apply one event to the state, in place. Events must arrive in seq order. */
export function applyEvent(state: FoldState, event: YojanaEvent): void {
  const { seq } = event;
  if (seq <= state.head) {
    state.anomalies.push({
      seq,
      code: 'OUT_OF_ORDER',
      message: `event ${seq} arrived after ${state.head}; skipped`,
    });
    return;
  }
  state.head = seq;

  switch (event.type) {
    case 'revision-recorded': {
      const plan = planFor(state, event.planId);
      const delta: Delta =
        event.base === undefined
          ? { op: 'add', requirement: event.requirement }
          : { op: 'modify', requirement: event.requirement, base: event.base };
      applyDelta(state, plan, delta, seq);
      return;
    }
    case 'requirement-removed': {
      const plan = planFor(state, event.planId);
      applyDelta(state, plan, { op: 'remove', id: event.id, base: event.base }, seq);
      return;
    }
    case 'change-opened': {
      const { change } = event;
      if (state.changes.has(change.id)) {
        state.anomalies.push({
          seq,
          code: 'DUPLICATE_CHANGE',
          message: `change ${change.id} was already opened; the later one is ignored`,
        });
        return;
      }
      planFor(state, change.planId);
      state.changes.set(change.id, {
        change,
        status: 'open',
        openedSeq: seq,
        openedAt: event.at,
        closedSeq: undefined,
        reason: undefined,
      });
      return;
    }
    case 'change-archived':
    case 'change-abandoned': {
      const entry = state.changes.get(event.changeId);
      if (entry === undefined || entry.status !== 'open') {
        state.anomalies.push({
          seq,
          code: 'CHANGE_NOT_OPEN',
          message: `change ${event.changeId} is ${entry?.status ?? 'unknown'}; ${event.type} ignored`,
        });
        return;
      }
      entry.closedSeq = seq;
      if (event.type === 'change-abandoned') {
        entry.status = 'abandoned';
        entry.reason = event.reason;
        return;
      }
      entry.status = 'archived';
      const plan = planFor(state, entry.change.planId);
      for (const delta of entry.change.deltas) applyDelta(state, plan, delta, seq);
      return;
    }
    case 'status-changed': {
      const plan = planFor(state, event.planId);
      plan.status = event.to;
      plan.statusHistory.push({
        to: event.to,
        reason: event.reason,
        actor: event.actor,
        at: event.at,
        seq,
      });
      return;
    }
    case 'work-linked': {
      planFor(state, event.planId).workItems = event.workItems;
      return;
    }
    case 'annotation-added': {
      planFor(state, event.planId).annotations.push(event.annotation);
      return;
    }
    default: {
      // A type from a newer yojana: kept in the log, reported here, never silently dropped.
      const type = (event as { readonly type: unknown }).type;
      state.anomalies.push({
        seq,
        code: 'UNKNOWN_EVENT',
        message: `event type ${String(type)} is not known to this version; skipped`,
      });
    }
  }
}

export function foldLog(events: Iterable<YojanaEvent>, state = emptyFoldState()): FoldState {
  for (const event of events) applyEvent(state, event);
  return state;
}

/** Current revision of every live requirement of a plan: the input to `findBaseConflicts`. */
export function planHeads(state: FoldState, planId: string): Map<RequirementId, RevisionHash> {
  const heads = new Map<RequirementId, RevisionHash>();
  for (const [id, requirement] of state.plans.get(planId)?.heads ?? []) {
    heads.set(id, requirement.revision);
  }
  return heads;
}

/** An annotation is outdated once its requirement has moved past the revision it was made on. */
export function isAnnotationOutdated(state: FoldState, planId: string, a: Annotation): boolean {
  return state.plans.get(planId)?.heads.get(a.requirement)?.revision !== a.revision;
}
