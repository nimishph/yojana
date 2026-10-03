import type { PullResult, PushResult, SyncPort, SyncStatus } from '@cntxt-labs/yojana-core';

/** Sync turned off: the log stays on this machine and every call says so. */
export class NoopSync implements SyncPort {
  readonly name = 'noop';

  async status(): Promise<SyncStatus> {
    return { state: 'uninitialized', localCount: 0, message: 'sync is not configured' };
  }

  async pull(): Promise<PullResult> {
    return { ok: false, pulled: [], error: 'sync is not configured' };
  }

  async push(): Promise<PushResult> {
    return { ok: false, pushedCount: 0, error: 'sync is not configured' };
  }
}
