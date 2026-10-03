import { foldLog, type StorePort, type WorkItem, type WorkLinkPort } from '@cntxt-labs/yojana-core';

/**
 * Progress of each plan, read from its work items. An item with children (an epic) counts its
 * children; an item without counts itself. Done means closed. Missing items are listed and count
 * as not done, so a typo in a bead id cannot make a plan look finished.
 */

export interface ItemProgress {
  readonly item: WorkItem;
  readonly children: readonly WorkItem[];
}

export interface PlanProgress {
  readonly planId: string;
  readonly items: readonly ItemProgress[];
  readonly done: number;
  readonly total: number;
  /** Set when the tracker could not be asked; counts are then zero and mean nothing. */
  readonly error: string | undefined;
}

export async function progress(options: {
  readonly store: StorePort;
  readonly worklink: WorkLinkPort;
  readonly planId?: string | undefined;
}): Promise<PlanProgress[]> {
  const state = foldLog(await options.store.events());
  const result: PlanProgress[] = [];
  for (const plan of state.plans.values()) {
    if (options.planId !== undefined && plan.id !== options.planId) continue;
    const failed = (error: string): PlanProgress => ({
      planId: plan.id,
      items: [],
      done: 0,
      total: 0,
      error,
    });

    const lookup = await options.worklink.get(plan.workItems);
    if (!lookup.ok) {
      result.push(failed(lookup.error));
      continue;
    }
    const items: ItemProgress[] = [];
    let error: string | undefined;
    for (const item of lookup.items) {
      if (item.state === 'missing') {
        items.push({ item, children: [] });
        continue;
      }
      const children = await options.worklink.children(item.id);
      if (!children.ok) {
        error = children.error;
        break;
      }
      items.push({ item, children: children.items });
    }
    if (error !== undefined) {
      result.push(failed(error));
      continue;
    }

    const counted = items.flatMap((p) => (p.children.length > 0 ? p.children : [p.item]));
    result.push({
      planId: plan.id,
      items,
      done: counted.filter((w) => w.state === 'closed').length,
      total: counted.length,
      error: undefined,
    });
  }
  return result;
}
