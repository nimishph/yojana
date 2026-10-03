/**
 * `missing`: the tracker has no such item (deleted, mistyped, or in another tracker).
 * `unknown`: the tracker has it, in a state this version does not recognise.
 */
export type WorkItemState =
  | 'open'
  | 'in-progress'
  | 'blocked'
  | 'closed'
  | 'deferred'
  | 'missing'
  | 'unknown';

export interface WorkItem {
  readonly id: string;
  readonly title: string;
  readonly state: WorkItemState;
  /** The tracker's own word for the state, kept for display when the state is `unknown`. */
  readonly rawState?: string | undefined;
}

export type WorkLookup =
  | { readonly ok: true; readonly items: readonly WorkItem[] }
  | { readonly ok: false; readonly error: string };

/**
 * Plan <-> execution. bd is the first adapter. A plan names its work items; progress is read
 * back from the tracker, never typed into the plan. A tracker that cannot be reached is an error
 * result, never an empty list that would read as "no work".
 */
export interface WorkLinkPort {
  readonly name: string;
  /** The items, in the order asked for; ids the tracker does not know come back `missing`. */
  get(ids: readonly string[]): Promise<WorkLookup>;
  /** Direct children of an item (an epic's tasks), closed ones included. */
  children(id: string): Promise<WorkLookup>;
}
