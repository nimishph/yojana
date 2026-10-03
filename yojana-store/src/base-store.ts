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
import { join } from 'node:path';
import { type BasePort, type PlanBase, YojanaError } from '@cntxt-labs/yojana-core';

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
 * One JSON file per plan under `dir` (default `.yojana/base/`), keys sorted so a commit's diff
 * shows exactly which requirements moved. Written to a temp file and renamed into place.
 */
export class FileBaseStore implements BasePort {
  readonly name = 'file';
  readonly dir: string;

  constructor(options: { readonly dir: string }) {
    this.dir = options.dir;
  }

  #path(planId: string): string {
    return join(this.dir, `${encodeURIComponent(planId)}.json`);
  }

  async get(planId: string): Promise<PlanBase | undefined> {
    const path = this.#path(planId);
    if (!existsSync(path)) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new YojanaError('BASE_UNREADABLE', `${path} is not valid JSON`, {
        hint: 'restore it from git, or delete it and ingest with --trust-file',
        cause: error,
      });
    }
    const base = raw as Partial<PlanBase>;
    if (base.planId !== planId || typeof base.revisions !== 'object' || base.revisions === null) {
      throw new YojanaError('BASE_UNREADABLE', `${path} is not a base for ${planId}`, {
        hint: 'restore it from git, or delete it and ingest with --trust-file',
      });
    }
    return { planId, status: base.status, revisions: base.revisions };
  }

  async set(base: PlanBase): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const revisions = Object.fromEntries(
      Object.entries(base.revisions).sort(([a], [b]) => a.localeCompare(b)),
    );
    const text = `${JSON.stringify({ planId: base.planId, status: base.status, revisions }, null, 2)}\n`;
    const path = this.#path(base.planId);
    const temp = `${path}.tmp`;
    const fd = openSync(temp, 'w');
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  }
}
