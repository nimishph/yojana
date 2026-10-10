import {
  type ActionId,
  type ParserPort,
  type RequirementId,
  type WorkLinkPort,
  YojanaError,
} from '@cntxt-labs/yojana-core';
import type { PlanFile } from './ingest.ts';

export interface SyncedAction {
  readonly requirement: RequirementId;
  readonly action: ActionId;
  readonly title: string;
  readonly bead: string;
  readonly parent?: string | undefined;
}

export interface SyncedPlanFile {
  readonly source: string;
  readonly planId: string;
  readonly actions: readonly SyncedAction[];
}

export interface ActionsSyncReport {
  readonly files: readonly SyncedPlanFile[];
  readonly dryRun: boolean;
}

/**
 * Creates beads for unlinked action items and writes the generated bead ids back into the plan files.
 * Parent issue is chosen from the requirement's first work item, or the plan's first work item.
 */
export async function syncActions(options: {
  readonly parser: ParserPort;
  readonly worklink: WorkLinkPort;
  readonly files: readonly PlanFile[];
  readonly writePlan?: ((source: string, text: string) => void) | undefined;
  readonly dryRun?: boolean | undefined;
  readonly planId?: string | undefined;
}): Promise<ActionsSyncReport> {
  const { parser, worklink, files, writePlan, dryRun = false } = options;
  const syncedFiles: SyncedPlanFile[] = [];

  for (const file of files) {
    const parsed = parser.parse(file.source, file.text);
    if (!parsed.ok) continue;
    if (options.planId !== undefined && parsed.plan.id !== options.planId) continue;

    // Collect all unlinked actions
    const unlinked: {
      reqId: RequirementId;
      actId: ActionId;
      title: string;
      parent?: string | undefined;
    }[] = [];

    for (const req of parsed.plan.requirements) {
      for (const act of req.actions ?? []) {
        if ((act.workItems ?? []).length === 0) {
          const parent = (req.workItems ?? [])[0] ?? (parsed.plan.workItems ?? [])[0];
          unlinked.push({ reqId: req.id, actId: act.id, title: act.text, parent });
        }
      }
    }

    if (unlinked.length === 0) continue;

    if (worklink.create === undefined) {
      throw new YojanaError(
        'WORKLINK_READONLY',
        `${worklink.name} does not support creating items`,
      );
    }

    const actions: SyncedAction[] = [];
    let updatedText = file.text;

    for (const item of unlinked) {
      if (dryRun) {
        actions.push({
          requirement: item.reqId,
          action: item.actId,
          title: item.title,
          bead: '(dry-run)',
          parent: item.parent,
        });
        continue;
      }

      const created = await worklink.create({
        title: item.title,
        parent: item.parent,
      });
      if (!created.ok) {
        throw new YojanaError('WORKLINK_ERROR', created.error);
      }

      actions.push({
        requirement: item.reqId,
        action: item.actId,
        title: item.title,
        bead: created.id,
        parent: item.parent,
      });

      // Write the new bead id back into the action line in updatedText
      const escaped = item.actId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(\\{#${escaped})\\s*\\}`);
      if (pattern.test(updatedText)) {
        updatedText = updatedText.replace(pattern, `$1 bead=${created.id}}`);
      } else {
        const alt = new RegExp(`(\\{#${escaped}\\b)`);
        updatedText = updatedText.replace(alt, `$1 bead=${created.id}`);
      }
    }

    if (!dryRun && actions.length > 0) {
      writePlan?.(file.source, updatedText);
    }

    syncedFiles.push({
      source: file.source,
      planId: parsed.plan.id,
      actions,
    });
  }

  return { files: syncedFiles, dryRun };
}
