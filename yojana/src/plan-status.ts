import {
  type BasePort,
  foldLog,
  type ParserPort,
  PLAN_STATUSES,
  type PlanStatus,
  type StatusProposal,
  type StorePort,
  YojanaError,
} from '@cntxt-labs/yojana-core';
import type { PlanFile } from './ingest.ts';
import { refresh } from './refresh.ts';

/**
 * A plan's status is a person's decision. An agent proposes a change of status (with a reason);
 * a person finalizes it, which moves the plan, or declines it. A person may also change the status
 * in one step. Every status, not only `accepted`, goes this way, so an agent never moves a plan on
 * its own.
 *
 * Approvals are the per-requirement side: a person approves a requirement as it reads now. They
 * help a person see what they have reviewed; they never gate a status change.
 */

export type ProposalResult =
  | { readonly ok: true; readonly proposal: StatusProposal; readonly moved: boolean }
  | { readonly ok: false; readonly code: string; readonly message: string };

const refuse = (code: string, message: string) => ({ ok: false as const, code, message });

/** Why an agent cannot do something only a person does, and what to do instead. */
const PERSON_ONLY =
  'only a person decides this; the person does it on the review page, or runs yojana themselves';

function isStatus(value: string): value is PlanStatus {
  return (PLAN_STATUSES as readonly string[]).includes(value);
}

/**
 * Propose moving a plan to `to`. Asking again for a move already waiting does not add a second
 * proposal. With `finalize` (a person changing the status directly) the plan moves at once.
 */
export async function proposeStatus(request: {
  readonly store: StorePort;
  readonly planId: string;
  readonly to: string;
  readonly reason: string;
  readonly actor: string;
  /** The actor is an agent: it may propose, never finalize. */
  readonly agent: boolean;
  readonly finalize: boolean;
}): Promise<ProposalResult> {
  if (request.finalize && request.agent) return refuse('PERSON_ONLY', PERSON_ONLY);
  const state = foldLog(await request.store.events());
  const plan = state.plans.get(request.planId);
  if (plan === undefined) return refuse('PLAN_NOT_FOUND', `the log has no plan ${request.planId}`);
  if (!isStatus(request.to)) {
    return refuse('INVALID', `a plan status is one of ${PLAN_STATUSES.join(', ')}`);
  }
  if (plan.status === request.to) {
    return refuse('ALREADY', `${request.planId} is already ${request.to}`);
  }
  const reason = request.reason.trim();

  const waiting = [...state.proposals.values()].find(
    (p) => p.planId === plan.id && p.to === request.to && p.status === 'proposed',
  );
  if (waiting !== undefined) {
    if (!request.finalize) return { ok: true, proposal: waiting, moved: false };
    return finalizeStatus({ ...request, proposalId: waiting.id });
  }

  if (reason === '') return refuse('REASON_REQUIRED', 'say why');
  const proposed = await request.store.append(
    { type: 'status-proposed', planId: plan.id, to: request.to, reason },
    request.actor,
  );
  if (!request.finalize) {
    return {
      ok: true,
      proposal: proposalById(await request.store.events(), proposed.eventId),
      moved: false,
    };
  }
  return finalizeStatus({ ...request, proposalId: proposed.eventId });
}

/** Finalize a proposal: the plan moves to its status. A person only. */
export async function finalizeStatus(request: {
  readonly store: StorePort;
  readonly proposalId: string;
  readonly actor: string;
  readonly agent: boolean;
  /** Why, in the person's words; the proposal's reason when left empty. */
  readonly reason?: string | undefined;
}): Promise<ProposalResult> {
  if (request.agent) return refuse('PERSON_ONLY', PERSON_ONLY);
  const proposal = foldLog(await request.store.events()).proposals.get(request.proposalId);
  if (proposal === undefined)
    return refuse('NOT_FOUND', `no status proposal ${request.proposalId}`);
  if (proposal.status !== 'proposed') {
    return refuse(
      'NOT_PROPOSED',
      `status proposal ${request.proposalId} is already ${proposal.status}`,
    );
  }
  const reason = request.reason?.trim() || proposal.reason;
  await request.store.append(
    {
      type: 'status-changed',
      planId: proposal.planId,
      to: proposal.to,
      reason,
      proposal: proposal.id,
    },
    request.actor,
  );
  return {
    ok: true,
    proposal: proposalById(await request.store.events(), proposal.id),
    moved: true,
  };
}

/** Decline a proposal: the plan stays as it is. A person only, and they say why. */
export async function declineStatus(request: {
  readonly store: StorePort;
  readonly proposalId: string;
  readonly reason: string;
  readonly actor: string;
  readonly agent: boolean;
}): Promise<ProposalResult> {
  if (request.agent) return refuse('PERSON_ONLY', PERSON_ONLY);
  const proposal = foldLog(await request.store.events()).proposals.get(request.proposalId);
  if (proposal === undefined)
    return refuse('NOT_FOUND', `no status proposal ${request.proposalId}`);
  if (proposal.status !== 'proposed') {
    return refuse(
      'NOT_PROPOSED',
      `status proposal ${request.proposalId} is already ${proposal.status}`,
    );
  }
  const reason = request.reason.trim();
  if (reason === '') return refuse('REASON_REQUIRED', 'say why not yet');
  await request.store.append(
    { type: 'status-declined', proposalId: proposal.id, reason },
    request.actor,
  );
  return {
    ok: true,
    proposal: proposalById(await request.store.events(), proposal.id),
    moved: false,
  };
}

function proposalById(events: Parameters<typeof foldLog>[0], id: string): StatusProposal {
  const proposal = foldLog(events).proposals.get(id);
  if (proposal === undefined) {
    // Just appended; a log that does not give it back is broken, not a person's mistake.
    throw new YojanaError(
      'LOG_INCONSISTENT',
      `status proposal ${id} is missing from the log it was written to`,
    );
  }
  return proposal;
}

/**
 * Bring the plan file's status line in step after a proposal was decided. Finalized: the log moved
 * past the file, which refresh brings in. Declined, when the proposal came from editing the status
 * line (the file still says what was declined): the file's line is taken as the base, so refresh
 * sees it behind the log and writes the log's status back.
 */
export async function settleStatusLine(options: {
  readonly store: StorePort;
  readonly parser: ParserPort;
  readonly bases: BasePort;
  readonly files: readonly PlanFile[];
  readonly writePlan: (source: string, text: string) => void;
  readonly proposal: StatusProposal;
}): Promise<void> {
  const { proposal } = options;
  if (proposal.status === 'declined') {
    const file = options.files
      .map((f) => options.parser.parse(f.source, f.text))
      .find((p) => p.ok && p.plan.id === proposal.planId);
    const base = await options.bases.get(proposal.planId);
    if (file?.ok && file.plan.status === proposal.to && base !== undefined) {
      await options.bases.set({ ...base, status: proposal.to });
    }
  }
  await refresh({
    store: options.store,
    parser: options.parser,
    bases: options.bases,
    files: options.files,
    writePlan: options.writePlan,
  });
}

export type ApprovalResult =
  | { readonly ok: true; readonly revision: string; readonly already: boolean }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Approve a requirement as it reads now. With `revision` (what the person read), approving a
 * requirement that has moved since is refused. Approving again what is already approved at the
 * current revision adds nothing. A person only.
 */
export async function approveRequirement(request: {
  readonly store: StorePort;
  readonly planId: string;
  readonly requirement: string;
  readonly revision?: string | undefined;
  readonly actor: string;
  readonly agent: boolean;
}): Promise<ApprovalResult> {
  if (request.agent) return refuse('PERSON_ONLY', PERSON_ONLY);
  const plan = foldLog(await request.store.events()).plans.get(request.planId);
  if (plan === undefined) return refuse('PLAN_NOT_FOUND', `the log has no plan ${request.planId}`);
  const head = plan.heads.get(request.requirement);
  if (head === undefined) {
    return refuse('NOT_FOUND', `${request.requirement} is not a requirement of ${request.planId}`);
  }
  if (
    request.revision !== undefined &&
    request.revision !== '' &&
    request.revision !== head.revision
  ) {
    return refuse(
      'STALE',
      `${request.requirement} changed since it was read; read it again before approving`,
    );
  }
  const verdict = plan.approvals.get(head.id);
  if (verdict?.verdict === 'approved' && verdict.revision === head.revision) {
    return { ok: true, revision: head.revision, already: true };
  }
  await request.store.append(
    {
      type: 'requirement-approved',
      planId: plan.id,
      requirement: head.id,
      revision: head.revision,
    },
    request.actor,
  );
  return { ok: true, revision: head.revision, already: false };
}

/**
 * Decline a requirement as it reads now, saying why (what would make it approvable): the other
 * verdict to approving. Like an approval it is a review mark, not a gate, and goes stale when the
 * requirement moves. The latest verdict stands, so approving later replaces it. A person only.
 */
export async function declineRequirement(request: {
  readonly store: StorePort;
  readonly planId: string;
  readonly requirement: string;
  readonly reason: string;
  readonly revision?: string | undefined;
  readonly actor: string;
  readonly agent: boolean;
}): Promise<ApprovalResult> {
  if (request.agent) return refuse('PERSON_ONLY', PERSON_ONLY);
  const reason = request.reason.trim();
  if (reason === '') {
    return refuse('REASON_REQUIRED', 'say why it is declined, so it can be changed to fit');
  }
  const plan = foldLog(await request.store.events()).plans.get(request.planId);
  if (plan === undefined) return refuse('PLAN_NOT_FOUND', `the log has no plan ${request.planId}`);
  const head = plan.heads.get(request.requirement);
  if (head === undefined) {
    return refuse('NOT_FOUND', `${request.requirement} is not a requirement of ${request.planId}`);
  }
  if (
    request.revision !== undefined &&
    request.revision !== '' &&
    request.revision !== head.revision
  ) {
    return refuse(
      'STALE',
      `${request.requirement} changed since it was read; read it again before declining`,
    );
  }
  const verdict = plan.approvals.get(head.id);
  if (
    verdict?.verdict === 'declined' &&
    verdict.revision === head.revision &&
    verdict.reason === reason
  ) {
    return { ok: true, revision: head.revision, already: true };
  }
  await request.store.append(
    {
      type: 'requirement-declined',
      planId: plan.id,
      requirement: head.id,
      revision: head.revision,
      reason,
    },
    request.actor,
  );
  return { ok: true, revision: head.revision, already: false };
}
