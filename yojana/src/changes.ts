import {
  type BaseConflict,
  type BasePort,
  type Change,
  type ChangeDraft,
  type Delta,
  findBaseConflicts,
  foldLog,
  type ParserPort,
  type Plan,
  type PlanPart,
  planHeads,
  type RequirementId,
  type StorePort,
} from '@cntxt-labs/yojana-core';
import type { PlanFile } from './ingest.ts';

/**
 * Changes: proposed edits to a plan, opened against the log and later archived or abandoned.
 *
 *   open      pins every MODIFIED/REMOVED requirement to its revision in the log right now, and
 *             refuses edits that cannot apply (adding an id that exists, editing one that does not).
 *   archive   applies the change only if every pinned revision is still current; otherwise it
 *             names each requirement that moved. When the plan file is in step with the log it is
 *             rewritten to match; a file with unrecorded edits is never overwritten.
 *   abandon   closes a change with a reason; nothing is applied.
 */

export interface ChangeProblem {
  readonly requirement: RequirementId | undefined;
  readonly code: string;
  readonly message: string;
}

export interface OpenChangeResult {
  readonly outcome: 'opened' | 'refused';
  readonly change: Change | undefined;
  readonly problems: readonly ChangeProblem[];
}

export async function openChange(options: {
  readonly store: StorePort;
  readonly draft: ChangeDraft;
  readonly actor: string;
}): Promise<OpenChangeResult> {
  const { store, draft, actor } = options;
  const state = foldLog(await store.events());
  const problems: ChangeProblem[] = [];
  const refuse = (requirement: RequirementId | undefined, code: string, message: string) =>
    problems.push({ requirement, code, message });

  const existing = state.changes.get(draft.id);
  if (existing !== undefined) {
    refuse(
      undefined,
      'CHANGE_EXISTS',
      `change ${draft.id} was already opened (${existing.status})`,
    );
  }
  const plan = state.plans.get(draft.planId);
  if (plan === undefined) {
    refuse(undefined, 'PLAN_NOT_FOUND', `the log has no plan ${draft.planId}; ingest it first`);
  }

  const heads = planHeads(state, draft.planId);
  const deltas: Delta[] = [];
  for (const delta of draft.deltas) {
    if (delta.op === 'add') {
      const { id } = delta.requirement;
      if (heads.has(id)) refuse(id, 'ALREADY_EXISTS', `${id} already exists; use MODIFIED`);
      else deltas.push({ op: 'add', requirement: delta.requirement });
      continue;
    }
    const id = delta.op === 'remove' ? delta.id : delta.requirement.id;
    const base = heads.get(id);
    if (base === undefined) {
      refuse(id, 'NOT_FOUND', `${id} is not in ${draft.planId}; use ADDED`);
    } else if (delta.op === 'remove') {
      deltas.push({ op: 'remove', id, base });
    } else if (delta.requirement.revision === base) {
      refuse(id, 'UNCHANGED', `${id} is marked MODIFIED but reads the same as the plan`);
    } else {
      deltas.push({ op: 'modify', requirement: delta.requirement, base });
    }
  }

  if (problems.length > 0) return { outcome: 'refused', change: undefined, problems };
  const change: Change = {
    id: draft.id,
    planId: draft.planId,
    title: draft.title,
    deltas,
    source: draft.source,
  };
  await store.append({ type: 'change-opened', change }, actor);
  return { outcome: 'opened', change, problems };
}

export type PlanFileUpdate =
  | { readonly updated: true; readonly source: string }
  | {
      readonly updated: false;
      readonly source: string | undefined;
      readonly reason: 'not-found' | 'invalid' | 'out-of-step';
    };

export interface ArchiveResult {
  readonly outcome: 'archived' | 'refused';
  readonly change: Change | undefined;
  readonly problems: readonly ChangeProblem[];
  readonly conflicts: readonly BaseConflict[];
  readonly planFile: PlanFileUpdate | undefined;
}

/**
 * The plan with a change's deltas applied: modified in place, added after the last requirement,
 * removed dropped.
 */
export function applyChange(plan: Plan, deltas: readonly Delta[]): Plan {
  let requirements = [...plan.requirements];
  let parts: PlanPart[] = [...plan.parts];
  for (const delta of deltas) {
    if (delta.op === 'remove') {
      requirements = requirements.filter((r) => r.id !== delta.id);
      parts = parts.filter((p) => p.kind !== 'requirement' || p.id !== delta.id);
    } else if (delta.op === 'modify') {
      requirements = requirements.map((r) =>
        r.id === delta.requirement.id ? delta.requirement : r,
      );
    } else {
      // After the last requirement, so trailing prose (notes, out of scope) stays last.
      requirements.push(delta.requirement);
      const lastRequirement = parts.findLastIndex((p) => p.kind === 'requirement');
      parts.splice(lastRequirement + 1, 0, { kind: 'requirement', id: delta.requirement.id });
    }
  }
  return { ...plan, requirements, parts };
}

export async function archiveChange(options: {
  readonly store: StorePort;
  readonly bases: BasePort;
  readonly parser: ParserPort;
  readonly changeId: string;
  readonly actor: string;
  /** Current plan files, to find and update the one this change edits. */
  readonly planFiles: readonly PlanFile[];
  /** Writes a plan file. Called before its base is updated, so a crash leaves the file behind, never ahead. */
  readonly writePlan: (source: string, text: string) => void;
}): Promise<ArchiveResult> {
  const { store, bases, parser, changeId, actor } = options;
  const state = foldLog(await store.events());
  const entry = state.changes.get(changeId);
  const refused = (code: string, message: string): ArchiveResult => ({
    outcome: 'refused',
    change: entry?.change,
    problems: [{ requirement: undefined, code, message }],
    conflicts: [],
    planFile: undefined,
  });
  if (entry === undefined) return refused('CHANGE_NOT_FOUND', `no change ${changeId} in the log`);
  if (entry.status !== 'open') {
    return refused('CHANGE_NOT_OPEN', `change ${changeId} is already ${entry.status}`);
  }

  const { change } = entry;
  const heads = planHeads(state, change.planId);
  const conflicts = findBaseConflicts(heads, change.deltas);
  if (conflicts.length > 0) {
    return { outcome: 'refused', change, problems: [], conflicts, planFile: undefined };
  }

  // Decide about the plan file before anything is written.
  let found: { readonly source: string; readonly plan: Plan | undefined } | undefined;
  for (const file of options.planFiles) {
    const parsed = parser.parse(file.source, file.text);
    if (parsed.ok && parsed.plan.id === change.planId) {
      found = { source: file.source, plan: parsed.plan };
      break;
    }
  }
  const logStatus = state.plans.get(change.planId)?.status;
  const inStep =
    found?.plan !== undefined &&
    found.plan.status === logStatus &&
    found.plan.requirements.length === heads.size &&
    found.plan.requirements.every((r) => heads.get(r.id) === r.revision);

  await store.append({ type: 'change-archived', changeId }, actor);

  let planFile: PlanFileUpdate;
  if (found?.plan === undefined) {
    planFile = { updated: false, source: undefined, reason: 'not-found' };
  } else if (!inStep) {
    planFile = { updated: false, source: found.source, reason: 'out-of-step' };
  } else {
    const next = applyChange(found.plan, change.deltas);
    options.writePlan(found.source, parser.render(next));
    await bases.set({
      planId: next.id,
      status: next.status,
      revisions: Object.fromEntries(next.requirements.map((r) => [r.id, r.revision])),
    });
    planFile = { updated: true, source: found.source };
  }
  return { outcome: 'archived', change, problems: [], conflicts: [], planFile };
}

export interface AbandonResult {
  readonly outcome: 'abandoned' | 'refused';
  readonly change: Change | undefined;
  readonly problems: readonly ChangeProblem[];
}

export async function abandonChange(options: {
  readonly store: StorePort;
  readonly changeId: string;
  readonly reason: string;
  readonly actor: string;
}): Promise<AbandonResult> {
  const { store, changeId, actor } = options;
  const reason = options.reason.trim();
  const entry = foldLog(await store.events()).changes.get(changeId);
  const refused = (code: string, message: string): AbandonResult => ({
    outcome: 'refused',
    change: entry?.change,
    problems: [{ requirement: undefined, code, message }],
  });
  if (reason === '') return refused('REASON_REQUIRED', 'say why the change is abandoned');
  if (entry === undefined) return refused('CHANGE_NOT_FOUND', `no change ${changeId} in the log`);
  if (entry.status !== 'open') {
    return refused('CHANGE_NOT_OPEN', `change ${changeId} is already ${entry.status}`);
  }
  await store.append({ type: 'change-abandoned', changeId, reason }, actor);
  return { outcome: 'abandoned', change: entry.change, problems: [] };
}
