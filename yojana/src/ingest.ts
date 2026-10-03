import {
  type BasePort,
  foldLog,
  type ParseIssue,
  type ParserPort,
  type PlanStatus,
  type RequirementId,
  type RevisionHash,
  type StorePort,
  type YojanaEventInput,
} from '@cntxt-labs/yojana-core';

/**
 * Ingest: bring edited plan files into the log.
 *
 * Each requirement (and the plan's status) is compared three ways: the file (F), the base the file
 * was last in step with (B), and the log (L).
 *
 *   F = L          in step; nothing to record
 *   B = L, F != L  the file was edited; record it on top of L
 *   F = B, F != L  the log moved and the file did not; the file is behind (reported, not changed)
 *   otherwise      both moved; the whole file is refused, nothing is recorded
 *
 * A plan is ingested all or nothing. Re-running with no edits appends nothing.
 */

export interface PlanFile {
  readonly source: string;
  readonly text: string;
}

export interface IngestOptions {
  readonly store: StorePort;
  readonly parser: ParserPort;
  readonly bases: BasePort;
  readonly files: readonly PlanFile[];
  readonly actor: string;
  /**
   * For a plan the log knows but that has no base (a base file was lost): treat the file as
   * edited on top of the log instead of refusing.
   */
  readonly trustFile?: boolean | undefined;
}

export type Movement = 'same' | 'edited' | 'behind' | 'conflict';

export interface RequirementOutcome {
  readonly id: RequirementId;
  readonly movement: Exclude<Movement, 'same'>;
  /** What the edit does to the log; set when movement is 'edited'. */
  readonly action?: 'added' | 'modified' | 'removed' | undefined;
  readonly file: RevisionHash | undefined;
  readonly base: RevisionHash | undefined;
  readonly log: RevisionHash | undefined;
}

export interface StatusOutcome {
  readonly movement: Exclude<Movement, 'same'>;
  readonly file: PlanStatus;
  readonly base: PlanStatus | undefined;
  readonly log: PlanStatus | undefined;
}

export interface FileReport {
  readonly source: string;
  readonly planId: string | undefined;
  /** invalid: did not parse; refused: a conflict; recorded: events appended; unchanged: none needed. */
  readonly outcome: 'invalid' | 'refused' | 'recorded' | 'unchanged';
  readonly issues: readonly ParseIssue[];
  readonly requirements: readonly RequirementOutcome[];
  readonly status: StatusOutcome | undefined;
  /** True when the plan had no base and the log already knew it (see `trustFile`). */
  readonly missingBase: boolean;
  readonly appended: number;
}

export interface IngestReport {
  readonly files: readonly FileReport[];
  readonly appended: number;
}

export function movement<T>(
  file: T | undefined,
  base: T | undefined,
  log: T | undefined,
): Movement {
  if (file === log) return 'same';
  if (base === log) return 'edited';
  if (file === base) return 'behind';
  return 'conflict';
}

export async function ingest(options: IngestOptions): Promise<IngestReport> {
  const { store, parser, bases, actor } = options;
  const reports: FileReport[] = [];
  const seenPlans = new Map<string, string>();
  let appended = 0;

  for (const file of options.files) {
    const parsed = parser.parse(file.source, file.text);
    if (!parsed.ok) {
      reports.push(invalid(file.source, undefined, parsed.issues));
      continue;
    }
    const { plan } = parsed;
    const earlier = seenPlans.get(plan.id);
    if (earlier !== undefined) {
      reports.push(
        invalid(file.source, plan.id, [
          {
            source: file.source,
            line: undefined,
            code: 'DUPLICATE_PLAN',
            message: `plan ${plan.id} is already defined in ${earlier}`,
          },
        ]),
      );
      continue;
    }
    seenPlans.set(plan.id, file.source);

    // Fold fresh for each file: an earlier file in this run may have appended.
    const state = foldLog(await store.events());
    const logPlan = state.plans.get(plan.id);
    const savedBase = await bases.get(plan.id);
    const missingBase = savedBase === undefined && logPlan !== undefined;

    const fileRevs = new Map(plan.requirements.map((r) => [r.id, r.revision]));
    const logRevs = new Map([...(logPlan?.heads ?? [])].map(([id, r]) => [id, r.revision]));
    const baseRevs = new Map<RequirementId, RevisionHash>(
      missingBase && options.trustFile === true
        ? logRevs
        : Object.entries(savedBase?.revisions ?? {}),
    );
    const logStatus = logPlan?.status;
    const baseStatus = missingBase && options.trustFile === true ? logStatus : savedBase?.status;

    const ids = [...new Set([...fileRevs.keys(), ...logRevs.keys(), ...baseRevs.keys()])];
    const outcomes: RequirementOutcome[] = [];
    const nextBase: Record<RequirementId, RevisionHash> = {};

    for (const id of ids) {
      const f = fileRevs.get(id);
      const b = baseRevs.get(id);
      const l = logRevs.get(id);
      const moved = movement(f, b, l);
      const kept = moved === 'behind' ? b : f;
      if (kept !== undefined && moved !== 'conflict') nextBase[id] = kept;
      if (moved === 'same') continue;
      const action =
        moved !== 'edited'
          ? undefined
          : f === undefined
            ? 'removed'
            : l === undefined
              ? 'added'
              : 'modified';
      outcomes.push({ id, movement: moved, action, file: f, base: b, log: l });
    }

    const statusMove = movement<PlanStatus>(plan.status, baseStatus, logStatus);
    const status: StatusOutcome | undefined =
      statusMove === 'same'
        ? undefined
        : { movement: statusMove, file: plan.status, base: baseStatus, log: logStatus };

    const refused = statusMove === 'conflict' || outcomes.some((o) => o.movement === 'conflict');
    if (refused) {
      reports.push({
        source: file.source,
        planId: plan.id,
        outcome: 'refused',
        issues: [],
        requirements: outcomes,
        status,
        missingBase,
        appended: 0,
      });
      continue;
    }

    const events: YojanaEventInput[] = [];
    if (status?.movement === 'edited') {
      events.push({
        type: 'status-changed',
        planId: plan.id,
        to: plan.status,
        reason:
          logStatus === undefined ? `created from ${file.source}` : `edited in ${file.source}`,
      });
    }
    const byId = new Map(plan.requirements.map((r) => [r.id, r]));
    for (const o of outcomes) {
      if (o.movement !== 'edited') continue;
      const requirement = byId.get(o.id);
      if (o.action === 'removed' && o.log !== undefined) {
        events.push({ type: 'requirement-removed', planId: plan.id, id: o.id, base: o.log });
      } else if (requirement !== undefined) {
        events.push({ type: 'revision-recorded', planId: plan.id, requirement, base: o.log });
      }
    }

    for (const event of events) await store.append(event, actor);
    appended += events.length;
    await bases.set({
      planId: plan.id,
      status: status?.movement === 'behind' ? baseStatus : plan.status,
      revisions: nextBase,
    });

    reports.push({
      source: file.source,
      planId: plan.id,
      outcome: events.length > 0 ? 'recorded' : 'unchanged',
      issues: [],
      requirements: outcomes,
      status,
      missingBase,
      appended: events.length,
    });
  }

  return { files: reports, appended };
}

function invalid(
  source: string,
  planId: string | undefined,
  issues: readonly ParseIssue[],
): FileReport {
  return {
    source,
    planId,
    outcome: 'invalid',
    issues,
    requirements: [],
    status: undefined,
    missingBase: false,
    appended: 0,
  };
}
