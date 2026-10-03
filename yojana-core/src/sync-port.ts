import type { YojanaEvent } from './events.ts';

/**
 * SyncPort: copies the log somewhere else. Kept separate from StorePort so a remote never becomes
 * a second source of truth. The shapes follow medha's sync port on purpose: duplicated, not
 * shared, until the pattern has proven itself in both.
 */
export type SyncState = 'synced' | 'ahead' | 'behind' | 'diverged' | 'uninitialized';

export interface SyncStatus {
  readonly state: SyncState;
  readonly localCount: number;
  readonly remoteCount?: number | undefined;
  readonly message?: string | undefined;
}

export interface PullResult {
  readonly ok: boolean;
  readonly pulled: readonly YojanaEvent[];
  readonly error?: string | undefined;
}

export interface PushResult {
  readonly ok: boolean;
  readonly pushedCount: number;
  readonly error?: string | undefined;
}

export interface SyncPort {
  readonly name: string;
  status(): Promise<SyncStatus>;
  pull(): Promise<PullResult>;
  push(): Promise<PushResult>;
}
