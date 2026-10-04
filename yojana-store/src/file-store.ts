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
import {
  computeEventId,
  type OpenResult,
  type StorePort,
  type YojanaEvent,
  type YojanaEventInput,
} from '@cntxt-labs/yojana-core';
import { CorruptStoreError, StoreClosedError } from './errors.ts';

/**
 * FileStore: the revision log as JSON Lines, one event per line, default `.yojana/log.jsonl`.
 *
 *   - **Append-only.** A write adds one line and fsyncs it, so a git diff of the log reads as the
 *     list of what happened, and nothing earlier is ever rewritten by normal use.
 *   - **Merge-friendly.** Lines carry an event id but no position. Order is the order of lines, so
 *     a log that git merged line by line (merge=union) from two branches reads as one log.
 *   - **Checked on open.** Every line must be a JSON event, and no id may appear twice. The first
 *     line that fails (garbage, a torn final write, a repeated event) marks the log corrupt from
 *     that position: reads keep serving the good prefix, appends refuse.
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

/**
 * Decode one stored line. Lines written before event ids existed carry a `seq` and no `eventId`; their
 * id is computed from their content, and the stored seq is ignored like any stored position.
 */
function decodeLine(line: string, seq: number): YojanaEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { eventId, seq: _storedSeq, at, actor, ...input } = value as Record<string, unknown>;
  if (typeof input.type !== 'string' || typeof at !== 'number' || typeof actor !== 'string') {
    return undefined;
  }
  const event = input as unknown as YojanaEventInput;
  const id = typeof eventId === 'string' ? eventId : computeEventId(event, at, actor);
  return { ...event, eventId: id, seq, at, actor };
}

/** What a line stores: everything but the position, which is derived on read. */
function encodeLine(event: YojanaEvent): string {
  const { seq: _position, ...stored } = event;
  return `${JSON.stringify(stored)}\n`;
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
    const ids = new Set<string>();
    for (const [index, line] of lines.entries()) {
      if (line.trim() === '') continue;
      const position = this.#log.length + 1;
      const event = decodeLine(line, position);
      if (event === undefined || ids.has(event.eventId)) {
        this.#badTail = lines.slice(index).join('\n');
        return { status: 'corrupt', source: this.path, atSeq: position };
      }
      ids.add(event.eventId);
      this.#log.push(event);
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
    const at = this.#now();
    const seq = this.#log.length + 1;
    const stored: YojanaEvent = {
      ...event,
      eventId: computeEventId(event, at, actor, seq),
      seq,
      at,
      actor,
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const fd = openSync(this.path, 'a');
    try {
      writeSync(fd, encodeLine(stored));
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
    writeDurably(temp, this.#log.map(encodeLine).join(''));
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
