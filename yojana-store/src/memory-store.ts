import type { OpenResult, StorePort, YojanaEvent, YojanaEventInput } from '@cntxt-labs/yojana-core';
import { StoreClosedError } from './errors.ts';

/** In-memory log: the reference backend. Survives close/open on the same instance. */
export class MemoryStore implements StorePort {
  readonly name = 'memory';
  readonly #log: YojanaEvent[] = [];
  readonly #now: () => number;
  #opened = false;

  constructor(options?: { now?: () => number }) {
    this.#now = options?.now ?? Date.now;
  }

  async open(): Promise<OpenResult> {
    this.#opened = true;
    return { status: 'ok' };
  }

  async close(): Promise<void> {
    this.#opened = false;
  }

  async append(event: YojanaEventInput, actor: string): Promise<YojanaEvent> {
    if (!this.#opened) throw new StoreClosedError(this.name);
    const stored: YojanaEvent = { ...event, seq: this.#log.length + 1, at: this.#now(), actor };
    this.#log.push(stored);
    return stored;
  }

  async events(afterSeq = 0, limit = Number.POSITIVE_INFINITY): Promise<YojanaEvent[]> {
    if (!this.#opened) throw new StoreClosedError(this.name);
    return this.#log.filter((e) => e.seq > afterSeq).slice(0, limit);
  }

  async head(): Promise<number> {
    if (!this.#opened) throw new StoreClosedError(this.name);
    return this.#log.length;
  }
}
