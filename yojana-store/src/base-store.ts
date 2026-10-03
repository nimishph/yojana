import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  type BasePort,
  PLAN_STATUSES,
  type PlanBase,
  type PlanStatus,
  type RequirementId,
  type RevisionHash,
  YojanaError,
} from '@cntxt-labs/yojana-core';

export class MemoryBaseStore implements BasePort {
  readonly name = 'memory';
  readonly #bases = new Map<string, PlanBase>();

  async get(planId: string): Promise<PlanBase | undefined> {
    return this.#bases.get(planId);
  }

  async set(base: PlanBase): Promise<void> {
    this.#bases.set(base.planId, base);
  }
}

/**
 * One JSON Lines file per plan under `dir` (default `.yojana/base/`):
 *
 *   {"planId":"plan/x","status":"accepted"}
 *   {"id":"req-a","revision":"r_..."}          one line per requirement, sorted by id
 *
 * One fact per line keeps git merges clean when two branches touch different requirements, and
 * the file stays readable after a union merge (`merge=union`) of edits to the same one: when a
 * line for the same thing appears twice, the last wins. A requirement edited on both branches is
 * contested in the log anyway, and ingest settles it from the plan file, not from the base.
 *
 * Written to a temp file and renamed into place.
 */
export class FileBaseStore implements BasePort {
  readonly name = 'file';
  readonly dir: string;

  constructor(options: { readonly dir: string }) {
    this.dir = options.dir;
  }

  #path(planId: string, extension = 'jsonl'): string {
    return join(this.dir, `${encodeURIComponent(planId)}.${extension}`);
  }

  async get(planId: string): Promise<PlanBase | undefined> {
    const path = this.#path(planId);
    if (existsSync(path)) return parseBaseLines(path, planId, readFileSync(path, 'utf8'));
    const legacy = this.#path(planId, 'json');
    if (existsSync(legacy)) return parseLegacyBase(legacy, planId, readFileSync(legacy, 'utf8'));
    return undefined;
  }

  async set(base: PlanBase): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const lines = [
      JSON.stringify({ planId: base.planId, status: base.status }),
      ...Object.entries(base.revisions)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, revision]) => JSON.stringify({ id, revision })),
    ];
    const path = this.#path(base.planId);
    const temp = `${path}.tmp`;
    const fd = openSync(temp, 'w');
    try {
      writeSync(fd, `${lines.join('\n')}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    rmSync(this.#path(base.planId, 'json'), { force: true });
  }
}

function unreadable(path: string, why: string, cause?: unknown): YojanaError {
  return new YojanaError('BASE_UNREADABLE', `${path}: ${why}`, {
    hint: 'restore it from git, or delete it and ingest with --trust-file',
    cause,
  });
}

function asStatus(value: unknown): PlanStatus | undefined {
  return PLAN_STATUSES.find((s) => s === value);
}

function parseBaseLines(path: string, planId: string, text: string): PlanBase {
  let status: PlanStatus | undefined;
  let sawHeader = false;
  const revisions: Record<RequirementId, RevisionHash> = {};
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw unreadable(path, `line ${index + 1} is not JSON`, error);
    }
    const entry = (value ?? {}) as Record<string, unknown>;
    if (typeof entry.planId === 'string') {
      if (entry.planId !== planId) throw unreadable(path, `is a base for ${entry.planId}`);
      sawHeader = true;
      status = asStatus(entry.status);
    } else if (typeof entry.id === 'string' && typeof entry.revision === 'string') {
      revisions[entry.id] = entry.revision;
    } else {
      throw unreadable(path, `line ${index + 1} is neither a header nor a requirement`);
    }
  }
  if (!sawHeader) throw unreadable(path, 'has no header line');
  return { planId, status, revisions };
}

/** The first base format: one pretty-printed JSON object. Read once, rewritten as lines on set. */
function parseLegacyBase(path: string, planId: string, text: string): PlanBase {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw unreadable(path, 'is not valid JSON', error);
  }
  const base = (raw ?? {}) as Partial<PlanBase>;
  if (base.planId !== planId || typeof base.revisions !== 'object' || base.revisions === null) {
    throw unreadable(path, `is not a base for ${planId}`);
  }
  return { planId, status: asStatus(base.status), revisions: base.revisions };
}
