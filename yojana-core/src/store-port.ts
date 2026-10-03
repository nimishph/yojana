import type { YojanaEvent, YojanaEventInput } from './events.ts';

/**
 * StorePort: where the revision log lives on this machine. Backends (in-memory, JSONL file,
 * SQLite later) must behave identically; one contract suite runs against all of them.
 *
 * A corrupt log never crashes the host: `open()` reports it, reads keep working up to the last
 * good event, and only appends refuse until it is repaired. Nothing is silently reset.
 */
export type OpenResult =
  | { readonly status: 'ok' }
  | { readonly status: 'corrupt'; readonly source: string; readonly atSeq: number };

export interface StorePort {
  readonly name: string;
  open(): Promise<OpenResult>;
  close(): Promise<void>;
  append(event: YojanaEventInput, actor: string): Promise<YojanaEvent>;
  /** Events with seq > afterSeq, in order, at most `limit` of them; callers page explicitly. */
  events(afterSeq?: number, limit?: number): Promise<YojanaEvent[]>;
  /** Highest seq in the log, 0 when empty. */
  head(): Promise<number>;
}
