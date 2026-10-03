import {
  type Anomaly,
  type BasePort,
  foldLog,
  openAnomalies,
  type ParseIssue,
  type ParserPort,
  type PlanStatus,
  type RequirementId,
  type StorePort,
  type WorkLinkPort,
} from '@cntxt-labs/yojana-core';
import { ingest, type PlanFile } from './ingest.ts';
import { type PlanProgress, progress } from './progress.ts';

/**
 * Status: one view of every plan, built from the log, the plan files and the tracker.
 *
 *   - lifecycle status and since when;
 *   - progress from the plan's beads (when a tracker is given);
 *   - the plan file against the log: edits not yet ingested, requirements the file is behind on,
 *     conflicts ingest would refuse (a dry-run ingest, so nothing is written);
 *   - contested requirements left by a merge;
 *   - open changes, with age; one open longer than `staleDays` is stale;
 *   - anomalies in the log.
 */

export type FileState =
  | {
      readonly kind: 'file';
      readonly source: string;
      readonly unrecorded: readonly RequirementId[];
      readonly behind: readonly RequirementId[];
      readonly conflicts: readonly RequirementId[];
      /** The status line in the file differs from the log in a way ingest would record. */
      readonly statusUnrecorded: boolean;
    }
  | { readonly kind: 'none' };

export interface OpenChange {
  readonly id: string;
  readonly title: string;
  readonly ageDays: number;
  readonly stale: boolean;
}

export interface PlanReport {
  readonly planId: string;
  readonly status: PlanStatus;
  /** When the current status was set; undefined if it never changed from draft. */
  readonly statusSince: number | undefined;
  readonly requirements: number;
  readonly claims: number;
  readonly file: FileState;
  readonly contested: readonly RequirementId[];
  readonly openChanges: readonly OpenChange[];
  readonly progress: PlanProgress | undefined;
}

export interface StatusReport {
  readonly plans: readonly PlanReport[];
  /** Plan files that do not parse (with why), or name a plan the log does not know yet. */
  readonly untracked: readonly {
    readonly source: string;
    readonly planId: string | undefined;
    readonly issues: readonly ParseIssue[];
  }[];
  /** Anomalies still needing attention (settled merge collisions are left out). */
  readonly anomalies: readonly Anomaly[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function status(options: {
  readonly store: StorePort;
  readonly parser: ParserPort;
  readonly bases: BasePort;
  readonly files: readonly PlanFile[];
  readonly worklink?: WorkLinkPort | undefined;
  readonly now: number;
  readonly staleDays: number;
  readonly planId?: string | undefined;
}): Promise<StatusReport> {
  const state = foldLog(await options.store.events());
  const dry = await ingest({
    store: options.store,
    parser: options.parser,
    bases: options.bases,
    files: options.files,
    actor: 'status',
    dryRun: true,
  });
  const fileFor = new Map<string, FileState>();
  const untracked: StatusReport['untracked'][number][] = [];
  for (const report of dry.files) {
    if (
      report.planId === undefined ||
      report.outcome === 'invalid' ||
      !state.plans.has(report.planId)
    ) {
      untracked.push({ source: report.source, planId: report.planId, issues: report.issues });
      continue;
    }
    const ids = (movement: string) =>
      report.requirements.filter((r) => r.movement === movement).map((r) => r.id);
    fileFor.set(report.planId, {
      kind: 'file',
      source: report.source,
      unrecorded: [...ids('edited'), ...ids('resolved')],
      behind: ids('behind'),
      conflicts: ids('conflict'),
      statusUnrecorded: report.status?.movement === 'edited',
    });
  }

  const progressFor = new Map<string, PlanProgress>();
  if (options.worklink !== undefined) {
    for (const p of await progress({
      store: options.store,
      worklink: options.worklink,
      planId: options.planId,
    })) {
      progressFor.set(p.planId, p);
    }
  }

  const plans: PlanReport[] = [];
  for (const plan of state.plans.values()) {
    if (options.planId !== undefined && plan.id !== options.planId) continue;
    const heads = [...plan.heads.values()];
    const openChanges = [...state.changes.values()]
      .filter((c) => c.status === 'open' && c.change.planId === plan.id)
      .map((c) => {
        const ageDays = Math.floor((options.now - c.openedAt) / DAY_MS);
        return {
          id: c.change.id,
          title: c.change.title,
          ageDays,
          stale: ageDays > options.staleDays,
        };
      });
    plans.push({
      planId: plan.id,
      status: plan.status,
      statusSince: plan.statusHistory.at(-1)?.at,
      requirements: heads.length,
      claims: heads.reduce((n, r) => n + r.claims.length, 0),
      file: fileFor.get(plan.id) ?? { kind: 'none' },
      contested: [...plan.contested.keys()],
      openChanges,
      progress: progressFor.get(plan.id),
    });
  }
  return { plans, untracked, anomalies: openAnomalies(state) };
}
