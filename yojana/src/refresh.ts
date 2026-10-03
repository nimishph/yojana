import {
  type BasePort,
  type Delta,
  foldLog,
  type ParserPort,
  type PlanStatus,
  type RequirementId,
  type StorePort,
} from '@cntxt-labs/yojana-core';
import { applyChange } from './changes.ts';
import { ingest, type PlanFile } from './ingest.ts';

/**
 * Refresh: bring the log's changes into plan files that have fallen behind.
 *
 * A requirement is behind when the file still matches its base but the log has moved on (a change
 * was archived while the file had other edits, or a pull brought log events). Because the file
 * still matches the base there, replacing it from the log loses nothing. Refresh touches only
 * those requirements (and the status line, if it is behind): edits not yet ingested stay as they
 * are, and their base is left alone so the next ingest still records them.
 *
 * The file is written before its base, so a crash leaves it behind again, never ahead.
 */

export interface RefreshedFile {
  readonly source: string;
  readonly planId: string;
  readonly updated: readonly RequirementId[];
  readonly added: readonly RequirementId[];
  readonly removed: readonly RequirementId[];
  readonly status: { readonly from: PlanStatus; readonly to: PlanStatus } | undefined;
}

export interface RefreshReport {
  readonly files: readonly RefreshedFile[];
}

export async function refresh(options: {
  readonly store: StorePort;
  readonly parser: ParserPort;
  readonly bases: BasePort;
  readonly files: readonly PlanFile[];
  readonly writePlan: (source: string, text: string) => void;
}): Promise<RefreshReport> {
  const { store, parser, bases } = options;
  const state = foldLog(await store.events());
  const dry = await ingest({
    store,
    parser,
    bases,
    files: options.files,
    actor: 'refresh',
    dryRun: true,
  });
  const textOf = new Map(options.files.map((f) => [f.source, f.text]));
  const refreshed: RefreshedFile[] = [];

  for (const report of dry.files) {
    const behind = report.requirements.filter((r) => r.movement === 'behind');
    const statusBehind = report.status?.movement === 'behind';
    if (report.planId === undefined || (behind.length === 0 && !statusBehind)) continue;

    const parsed = parser.parse(report.source, textOf.get(report.source) ?? '');
    const logPlan = state.plans.get(report.planId);
    if (!parsed.ok || logPlan === undefined) continue;

    const deltas: Delta[] = [];
    const updated: RequirementId[] = [];
    const added: RequirementId[] = [];
    const removed: RequirementId[] = [];
    for (const r of behind) {
      const head = logPlan.heads.get(r.id);
      if (head === undefined) {
        deltas.push({ op: 'remove', id: r.id, base: r.file ?? '' });
        removed.push(r.id);
      } else if (r.file === undefined) {
        deltas.push({ op: 'add', requirement: head });
        added.push(r.id);
      } else {
        deltas.push({ op: 'modify', requirement: head, base: r.file });
        updated.push(r.id);
      }
    }
    const next = applyChange(
      statusBehind ? { ...parsed.plan, status: logPlan.status } : parsed.plan,
      deltas,
    );
    options.writePlan(report.source, parser.render(next));

    // The base moves only for what was refreshed; everything else keeps its base, so an edit not
    // yet ingested is still seen as an edit.
    const saved = await bases.get(report.planId);
    const revisions: Record<RequirementId, string> = { ...(saved?.revisions ?? {}) };
    for (const id of removed) delete revisions[id];
    for (const id of [...updated, ...added]) {
      const head = logPlan.heads.get(id);
      if (head !== undefined) revisions[id] = head.revision;
    }
    await bases.set({
      planId: report.planId,
      status: statusBehind ? logPlan.status : saved?.status,
      revisions,
    });

    refreshed.push({
      source: report.source,
      planId: report.planId,
      updated,
      added,
      removed,
      status: statusBehind ? { from: parsed.plan.status, to: logPlan.status } : undefined,
    });
  }
  return { files: refreshed };
}
