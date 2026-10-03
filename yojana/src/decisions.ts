import {
  type DecisionState,
  foldLog,
  type StorePort,
  WORK_DECISIONS,
  type WorkDecision,
  type WorkItemState,
  type WorkLinkPort,
  YojanaError,
} from '@cntxt-labs/yojana-core';

/**
 * Decisions on work items, kept in the log as an outbox. A decision is recorded (an agent may
 * propose one), finalized by a person, and only then applied to the tracker (`bd close`). The
 * tracker is reached only by `applyDecisions`, so yojana stays loosely coupled to it: when bd is
 * down, a decision waits, finalized, and the next apply retries it.
 *
 * Applying is idempotent: an item already in the decided state counts as applied, and applied
 * decisions are never applied again.
 */

export type DecisionResult =
  | { readonly ok: true; readonly decision: DecisionState }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface DecisionRequest {
  readonly store: StorePort;
  readonly planId: string;
  readonly requirement: string;
  readonly item: string;
  readonly decision: string;
  readonly reason: string;
  readonly actor: string;
  /** A person deciding: record and finalize in one step. An agent's proposal leaves it false. */
  readonly finalize: boolean;
}

function isDecision(value: string): value is WorkDecision {
  return (WORK_DECISIONS as readonly string[]).includes(value);
}

/**
 * Record a decision. Asking again for one that is already waiting (proposed, finalized but not
 * applied, or failed) does not add a second: with `finalize` it finalizes the proposal, and a
 * finalized or failed one is returned as it is, for the caller to apply.
 */
export async function recordDecision(request: DecisionRequest): Promise<DecisionResult> {
  const refuse = (code: string, message: string): DecisionResult => ({ ok: false, code, message });
  const state = foldLog(await request.store.events());
  const plan = state.plans.get(request.planId);
  if (plan === undefined) return refuse('PLAN_NOT_FOUND', `the log has no plan ${request.planId}`);
  const requirement = plan.heads.get(request.requirement);
  if (requirement === undefined) {
    return refuse('NOT_FOUND', `${request.requirement} is not a requirement of ${request.planId}`);
  }
  if (!isDecision(request.decision)) {
    return refuse('INVALID', `a decision is one of ${WORK_DECISIONS.join(', ')}`);
  }
  const linked = requirement.workItems ?? [];
  if (!linked.includes(request.item)) {
    return refuse(
      'NOT_LINKED',
      `${request.item} is not linked to ${requirement.id}${linked.length > 0 ? ` (it links ${linked.join(', ')})` : ''}`,
    );
  }
  const reason = request.reason.trim();

  const waiting = [...state.decisions.values()].find(
    (d) =>
      d.planId === request.planId &&
      d.item === request.item &&
      d.decision === request.decision &&
      d.status !== 'applied',
  );
  if (waiting !== undefined) {
    if (waiting.status === 'recorded' && request.finalize) {
      await request.store.append(
        { type: 'decision-finalized', decisionId: waiting.id },
        request.actor,
      );
      return { ok: true, decision: decisionById(await request.store.events(), waiting.id) };
    }
    return { ok: true, decision: waiting };
  }

  if (reason === '') return refuse('REASON_REQUIRED', 'say why');
  const recorded = await request.store.append(
    {
      type: 'decision-recorded',
      planId: request.planId,
      requirement: requirement.id,
      item: request.item,
      decision: request.decision,
      reason,
    },
    request.actor,
  );
  if (request.finalize) {
    await request.store.append(
      { type: 'decision-finalized', decisionId: recorded.eventId },
      request.actor,
    );
  }
  return { ok: true, decision: decisionById(await request.store.events(), recorded.eventId) };
}

function decisionById(events: Parameters<typeof foldLog>[0], id: string): DecisionState {
  const decision = foldLog(events).decisions.get(id);
  if (decision === undefined) {
    // Just appended; a log that does not give it back is broken, not a person's mistake.
    throw new YojanaError(
      'LOG_INCONSISTENT',
      `decision ${id} is missing from the log it was written to`,
    );
  }
  return decision;
}

/** Finalize a proposed decision by its id. */
export async function finalizeDecision(options: {
  readonly store: StorePort;
  readonly decisionId: string;
  readonly actor: string;
}): Promise<DecisionResult> {
  const decision = foldLog(await options.store.events()).decisions.get(options.decisionId);
  if (decision === undefined) {
    return { ok: false, code: 'NOT_FOUND', message: `no decision ${options.decisionId}` };
  }
  if (decision.status !== 'recorded') {
    return {
      ok: false,
      code: 'NOT_PROPOSED',
      message: `decision ${options.decisionId} is already ${decision.status}`,
    };
  }
  await options.store.append(
    { type: 'decision-finalized', decisionId: options.decisionId },
    options.actor,
  );
  return { ok: true, decision: decisionById(await options.store.events(), options.decisionId) };
}

/** Whether an item in this state already is what the decision asks for. */
function alreadyDone(decision: WorkDecision, state: WorkItemState): boolean {
  if (decision === 'close') return state === 'closed';
  return state !== 'closed' && state !== 'missing' && state !== 'unknown';
}

export interface AppliedDecision {
  readonly id: string;
  readonly item: string;
  readonly decision: WorkDecision;
  readonly outcome: 'applied' | 'failed';
  readonly note: string;
}

/**
 * Apply finalized decisions (and retry failed ones) to the tracker, oldest first, and record
 * what happened to each. `ids` limits it to those decisions.
 */
export async function applyDecisions(options: {
  readonly store: StorePort;
  readonly worklink: WorkLinkPort;
  readonly actor: string;
  readonly ids?: readonly string[] | undefined;
}): Promise<AppliedDecision[]> {
  const state = foldLog(await options.store.events());
  const due = [...state.decisions.values()].filter(
    (d) =>
      (d.status === 'finalized' || d.status === 'failed') &&
      (options.ids === undefined || options.ids.includes(d.id)),
  );
  const out: AppliedDecision[] = [];
  for (const d of due) {
    const done = (note: string): AppliedDecision => ({
      id: d.id,
      item: d.item,
      decision: d.decision,
      outcome: 'applied',
      note,
    });
    const failed = (note: string): AppliedDecision => ({ ...done(note), outcome: 'failed' });

    let result: AppliedDecision;
    const lookup = await options.worklink.get([d.item]);
    const item = lookup.ok ? lookup.items[0] : undefined;
    if (!lookup.ok) {
      result = failed(lookup.error);
    } else if (item === undefined || item.state === 'missing') {
      result = failed(`${options.worklink.name} has no item ${d.item}`);
    } else if (alreadyDone(d.decision, item.state)) {
      result = done(`${d.item} was already ${item.state}`);
    } else {
      const act = d.decision === 'close' ? options.worklink.close : options.worklink.reopen;
      if (act === undefined) {
        result = failed(`${options.worklink.name} cannot ${d.decision} items from yojana`);
      } else {
        const changed = await act.call(options.worklink, d.item, d.reason);
        result = changed.ok
          ? done(`${d.decision === 'close' ? 'closed' : 'reopened'} ${d.item}`)
          : failed(changed.error);
      }
    }
    await options.store.append(
      result.outcome === 'applied'
        ? { type: 'decision-applied', decisionId: d.id, note: result.note }
        : { type: 'decision-failed', decisionId: d.id, error: result.note },
      options.actor,
    );
    out.push(result);
  }
  return out;
}
