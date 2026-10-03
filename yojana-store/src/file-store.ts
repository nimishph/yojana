import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { OpenResult, StorePort, YojanaEvent, YojanaEventInput } from '@cntxt-labs/yojana-core';
import { CorruptStoreError, StoreClosedError } from './errors.ts';

/**
 * FileStore: the revision log as JSON Lines, one event per line, default `.yojana/log.jsonl`.
 *
 *   - **Append-only.** A write adds one line and fsyncs it, so a git diff of the log reads as the
 *     list of what happened, and nothing earlier is ever rewritten by normal use.
 *   - **Checked on open.** Every line must be a JSON event whose seq is exactly one more than the
 *     previous. The first line that is not (garbage, a torn final write, a gap) marks the log
 *     corrupt from that seq: reads keep serving the good prefix, appends refuse.
 *   - **Never silently reset.** `repair()` rewrites the good prefix and moves the unreadable tail
 *     to a side file, so the bytes are still there to inspect.
 *
 * Duplicated in spirit from medha-store's file store (atomic, fsync, corruption reported not
 * thrown); not shared code, by decision, until the pattern has proven itself in both.
 */

export interface FileStoreOptions {
  readonly path: string;
  readonly now?: () => number;
}

export interface RepairResult {
  readonly kept: number;
  /** Where the unreadable tail went; undefined when there was nothing to move. */
  readonly quarantined: string | undefined;
}

function isEvent(value: unknown, expectedSeq: number): value is YojanaEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v.seq === expectedSeq &&
    typeof v.type === 'string' &&
    typeof v.at === 'number' &&
    typeof v.actor === 'string'
  );
}

export class FileStore implements StorePort {
  readonly name = 'file';
  readonly path: string;
  readonly #now: () => number;
  #opened = false;
  #log: YojanaEvent[] = [];
  /** Text of the unreadable tail, when the log is corrupt. */
  #badTail: string | undefined;

  constructor(options: FileStoreOptions) {
    this.path = options.path;
    this.#now = options.now ?? Date.now;
  }

  async open(): Promise<OpenResult> {
    this.#opened = true;
    this.#log = [];
    this.#badTail = undefined;
    if (!existsSync(this.path)) return { status: 'ok' };

    const lines = readFileSync(this.path, 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      if (line.trim() === '') continue;
      const expected = this.#log.length + 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = undefined;
      }
      if (!isEvent(parsed, expected)) {
        this.#badTail = lines.slice(index).join('\n');
        return { status: 'corrupt', source: this.path, atSeq: expected };
      }
      this.#log.push(parsed);
    }
    return { status: 'ok' };
  }

  async close(): Promise<void> {
    this.#opened = false;
  }

  async append(event: YojanaEventInput, actor: string): Promise<YojanaEvent> {
    this.#assertOpen();
    if (this.#badTail !== undefined) {
      throw new CorruptStoreError(this.path, this.#log.length + 1);
    }
    const stored: YojanaEvent = { ...event, seq: this.#log.length + 1, at: this.#now(), actor };
    mkdirSync(dirname(this.path), { recursive: true });
    const fd = openSync(this.path, 'a');
    try {
      writeSync(fd, `${JSON.stringify(stored)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.#log.push(stored);
    return stored;
  }

  async events(afterSeq = 0, limit = Number.POSITIVE_INFINITY): Promise<YojanaEvent[]> {
    this.#assertOpen();
    return this.#log.filter((e) => e.seq > afterSeq).slice(0, limit);
  }

  async head(): Promise<number> {
    this.#assertOpen();
    return this.#log.length;
  }

  /**
   * Keep every readable event and move the unreadable tail to `<path>.corrupt-<time>`. The good
   * prefix is written to a temp file, fsynced and renamed over the log, so a crash leaves either
   * the old log or the repaired one.
   */
  async repair(): Promise<RepairResult> {
    this.#assertOpen();
    if (this.#badTail === undefined) return { kept: this.#log.length, quarantined: undefined };

    const quarantined = `${this.path}.corrupt-${this.#now()}`;
    writeDurably(quarantined, this.#badTail);
    const temp = `${this.path}.tmp`;
    writeDurably(temp, this.#log.map((e) => `${JSON.stringify(e)}\n`).join(''));
    renameSync(temp, this.path);
    this.#badTail = undefined;
    return { kept: this.#log.length, quarantined };
  }

  #assertOpen(): void {
    if (!this.#opened) throw new StoreClosedError(this.name);
  }
}

function writeDurably(path: string, text: string): void {
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
