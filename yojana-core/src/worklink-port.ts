export type WorkItemState = 'open' | 'in-progress' | 'blocked' | 'closed' | 'deferred' | 'missing';

export interface WorkItem {
  readonly id: string;
  readonly title: string;
  readonly state: WorkItemState;
}

/** Plan <-> execution. bd is the first adapter: accepting a plan files beads; progress is read back. */
export interface WorkLinkPort {
  readonly name: string;
  create(parent: string | undefined, title: string, description: string): Promise<WorkItem>;
  get(ids: readonly string[]): Promise<WorkItem[]>;
}
