import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  WorkChange,
  WorkCreateResult,
  WorkItem,
  WorkLinkPort,
  WorkLookup,
} from '@cntxt-labs/yojana-core';
import { BdWorkLink, spawnBd } from './bd.ts';
import { ChecklistWorkLink } from './checklist.ts';
import { GhWorkLink, spawnGh } from './gh.ts';

export type TrackerType = 'bd' | 'github' | 'gh' | 'checklist' | 'markdown' | 'composite' | 'auto';

export interface CompositeWorkLinkOptions {
  readonly adapters: {
    readonly bd?: WorkLinkPort | undefined;
    readonly github?: WorkLinkPort | undefined;
    readonly checklist?: WorkLinkPort | undefined;
    readonly [name: string]: WorkLinkPort | undefined;
  };
  readonly default?: WorkLinkPort | undefined;
}

const GITHUB_ID_PATTERN =
  /^(?:#\d+|\d+|gh-\d+|gh#\d+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+|https?:\/\/github\.com\/.+)$/i;
const BEAD_ID_PATTERN = /^[a-z0-9]+-[a-z0-9]+(?:\.[a-z0-9]+)*$/i;
const CHECKLIST_ID_PATTERN = /^(?:req|act)-/i;

/**
 * CompositeWorkLink multiplexes multiple WorkLinkPort adapters:
 * - Issues like `#123`, `123`, `gh-123` route to GitHub
 * - Beads like `yoj-565`, `anv-yp2` route to bd
 * - Checklists like `req-auth`, `act-login` route to Checklist
 * - Fallbacks check other registered adapters
 */
export class CompositeWorkLink implements WorkLinkPort {
  readonly name = 'composite';
  readonly #adapters: Readonly<Record<string, WorkLinkPort>>;
  readonly #defaultAdapter: WorkLinkPort;

  constructor(options: CompositeWorkLinkOptions) {
    const map: Record<string, WorkLinkPort> = {};
    for (const [key, adapter] of Object.entries(options.adapters)) {
      if (adapter !== undefined) {
        map[key.toLowerCase()] = adapter;
      }
    }
    this.#adapters = map;
    this.#defaultAdapter =
      options.default ??
      map.bd ??
      map.checklist ??
      map.github ??
      Object.values(map)[0] ??
      new ChecklistWorkLink();
  }

  resolveAdapter(id: string): WorkLinkPort {
    if (GITHUB_ID_PATTERN.test(id) && this.#adapters.github) {
      return this.#adapters.github;
    }
    if (CHECKLIST_ID_PATTERN.test(id) && this.#adapters.checklist) {
      return this.#adapters.checklist;
    }
    if (BEAD_ID_PATTERN.test(id) && this.#adapters.bd) {
      return this.#adapters.bd;
    }
    return this.#defaultAdapter;
  }

  async get(ids: readonly string[]): Promise<WorkLookup> {
    if (ids.length === 0) return { ok: true, items: [] };

    // Group IDs by resolved adapter
    const groups = new Map<WorkLinkPort, string[]>();
    for (const id of ids) {
      const adapter = this.resolveAdapter(id);
      const list = groups.get(adapter) ?? [];
      list.push(id);
      groups.set(adapter, list);
    }

    const found = new Map<string, WorkItem>();

    const lookups = await Promise.all(
      [...groups.entries()].map(async ([adapter, groupIds]) => {
        const res = await adapter.get(groupIds);
        if (!res.ok) return res;
        for (const item of res.items) {
          found.set(item.id, item);
        }
        return { ok: true as const };
      }),
    );

    const failure = lookups.find((l) => !l.ok);
    if (failure !== undefined && !failure.ok) {
      return failure;
    }

    // For any items still marked missing, attempt other adapters as fallback
    const missingIds = ids.filter((id) => found.get(id)?.state === 'missing');
    if (missingIds.length > 0) {
      const otherAdapters = Object.values(this.#adapters);
      for (const adapter of otherAdapters) {
        const stillMissing = missingIds.filter((id) => found.get(id)?.state === 'missing');
        if (stillMissing.length === 0) break;
        const fallbackLookup = await adapter.get(stillMissing);
        if (fallbackLookup.ok) {
          for (const item of fallbackLookup.items) {
            if (item.state !== 'missing') {
              found.set(item.id, item);
            }
          }
        }
      }
    }

    return {
      ok: true,
      items: ids.map((id) => found.get(id) ?? { id, title: '', state: 'missing' as const }),
    };
  }

  async children(id: string): Promise<WorkLookup> {
    const primary = this.resolveAdapter(id);
    const result = await primary.children(id);
    if (result.ok && result.items.length > 0) return result;

    // Fallback: try other adapters
    for (const adapter of Object.values(this.#adapters)) {
      if (adapter === primary) continue;
      const alt = await adapter.children(id);
      if (alt.ok && alt.items.length > 0) return alt;
    }

    return result;
  }

  async close(id: string, reason: string): Promise<WorkChange> {
    const adapter = this.resolveAdapter(id);
    if (adapter.close !== undefined) {
      return adapter.close(id, reason);
    }
    return { ok: false, error: `${adapter.name} does not support closing items` };
  }

  async reopen(id: string, reason: string): Promise<WorkChange> {
    const adapter = this.resolveAdapter(id);
    if (adapter.reopen !== undefined) {
      return adapter.reopen(id, reason);
    }
    return { ok: false, error: `${adapter.name} does not support reopening items` };
  }

  async create(options: {
    readonly title: string;
    readonly parent?: string | undefined;
    readonly description?: string | undefined;
  }): Promise<WorkCreateResult> {
    const adapter = options.parent ? this.resolveAdapter(options.parent) : this.#defaultAdapter;
    if (adapter.create !== undefined) {
      return adapter.create(options);
    }
    return { ok: false, error: `${adapter.name} does not support creating items` };
  }
}

export interface CreateWorkLinkOptions {
  readonly type?: TrackerType | undefined;
  readonly root?: string | undefined;
  readonly plansDir?: string | undefined;
  readonly repo?: string | undefined;
  readonly bdBin?: string | undefined;
  readonly ghBin?: string | undefined;
}

/**
 * Creates the appropriate WorkLinkPort adapter based on options and workspace structure:
 * - 'bd': beads adapter
 * - 'github' / 'gh': GitHub Issues adapter
 * - 'checklist' / 'markdown': plain Markdown checklist adapter
 * - 'composite' / 'auto': composite multiplexer (auto-detects .beads, gh, and plans)
 */
export function createWorkLink(options: CreateWorkLinkOptions = {}): WorkLinkPort {
  const root = options.root ?? process.cwd();
  const bdBin = options.bdBin ?? process.env.BD_BIN ?? 'bd';
  const ghBin = options.ghBin ?? process.env.GH_BIN ?? 'gh';
  const plansDir = options.plansDir ?? join(root, 'plans');

  const bd = new BdWorkLink(spawnBd(bdBin, root));
  const github = new GhWorkLink(spawnGh(ghBin, root), { repo: options.repo });
  const checklist = new ChecklistWorkLink({ plansDir });

  const type = options.type ?? 'auto';

  if (type === 'bd') return bd;
  if (type === 'github' || type === 'gh') return github;
  if (type === 'checklist' || type === 'markdown') return checklist;

  // auto or composite:
  const hasBeads = existsSync(join(root, '.beads'));
  const defaultAdapter = hasBeads ? bd : checklist;

  return new CompositeWorkLink({
    adapters: { bd, github, checklist },
    default: defaultAdapter,
  });
}
