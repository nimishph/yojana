import type {
  WorkChange,
  WorkCreateResult,
  WorkItem,
  WorkItemState,
  WorkLinkPort,
  WorkLookup,
} from '@cntxt-labs/yojana-core';
import type { RunResult } from './bd.ts';

/**
 * GhRunner runs the gh CLI with arguments; throws when the program cannot be started.
 */
export type GhRunner = (args: readonly string[]) => Promise<RunResult>;

export function spawnGh(bin = 'gh', cwd: string): GhRunner {
  return async (args) => {
    const child = Bun.spawn([bin, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  };
}

export interface GhWorkLinkOptions {
  /** Target repository in OWNER/REPO format (passed as -R). */
  readonly repo?: string | undefined;
}

const NOT_FOUND = /could not resolve to an issue|issue not found|not found|404/i;

function mapGhState(state: string, stateReason?: string | null): WorkItemState {
  const upper = state.toUpperCase();
  if (upper === 'OPEN') return 'open';
  if (upper === 'CLOSED') {
    if (stateReason?.toUpperCase() === 'NOT_PLANNED') return 'deferred';
    return 'closed';
  }
  return 'unknown';
}

function normalizeId(id: string): string {
  if (id.startsWith('#')) return id.slice(1);
  if (id.startsWith('gh-') || id.startsWith('gh#')) return id.slice(3);
  return id;
}

function parseTarget(
  id: string,
  defaultRepo?: string,
): { target: string; repo?: string | undefined } {
  const urlMatch = id.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/i);
  if (urlMatch !== null && urlMatch[1] !== undefined && urlMatch[2] !== undefined) {
    return { repo: urlMatch[1], target: urlMatch[2] };
  }
  const repoMatch = id.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/);
  if (repoMatch !== null && repoMatch[1] !== undefined && repoMatch[2] !== undefined) {
    return { repo: repoMatch[1], target: repoMatch[2] };
  }
  return { repo: defaultRepo, target: normalizeId(id) };
}

/**
 * WorkLinkPort for GitHub Issues via `gh` CLI.
 *
 *   get       `gh issue view <id> --json number,title,state,stateReason,body,subIssues`
 *   children  Sub-issues list or body tasklists (`- [x] #123`, `- [ ] task`)
 *   close     `gh issue close <id> --comment <reason>`
 *   reopen    `gh issue reopen <id> --comment <reason>`
 *   create    `gh issue create --title <title> --body <desc> [--parent <parent>]`
 */
export class GhWorkLink implements WorkLinkPort {
  readonly name = 'github';
  readonly #run: GhRunner;
  readonly #repo?: string | undefined;

  constructor(run: GhRunner, options?: GhWorkLinkOptions) {
    this.#run = run;
    this.#repo = options?.repo;
  }

  async get(ids: readonly string[]): Promise<WorkLookup> {
    if (ids.length === 0) return { ok: true, items: [] };

    const found = new Map<string, WorkItem>();

    const lookups = await Promise.all(
      ids.map(async (id) => {
        const { target, repo } = parseTarget(id, this.#repo);
        const args = [
          'issue',
          'view',
          target,
          '--json',
          'number,title,state,stateReason,body,subIssues',
        ];
        if (repo !== undefined) args.push('-R', repo);

        let result: RunResult;
        try {
          result = await this.#run(args);
        } catch (error) {
          return {
            ok: false as const,
            error: `could not run gh (${String(error)}); install it or set GH_BIN`,
          };
        }

        if (result.exitCode !== 0) {
          const text = (result.stderr || result.stdout).trim();
          if (NOT_FOUND.test(text)) {
            const missingItem: WorkItem = { id, title: '', state: 'missing' };
            found.set(id, missingItem);
            found.set(target, missingItem);
            found.set(`#${target}`, missingItem);
            return { ok: true as const };
          }
          return {
            ok: false as const,
            error: `gh issue view ${target} failed (exit ${result.exitCode}): ${text}`,
          };
        }

        try {
          const raw = JSON.parse(result.stdout) as Record<string, unknown>;
          const num = String(raw.number ?? target);
          const rawState = String(raw.state ?? '');
          const state = mapGhState(rawState, raw.stateReason as string | null | undefined);
          const item: WorkItem = {
            id,
            title: String(raw.title ?? ''),
            state,
            rawState,
          };
          found.set(id, item);
          found.set(num, item);
          found.set(`#${num}`, item);
          if (repo !== undefined) {
            found.set(`${repo}#${num}`, item);
          }
          return { ok: true as const };
        } catch {
          const text = (result.stderr || result.stdout).trim();
          return {
            ok: false as const,
            error: `gh did not answer in JSON (exit ${result.exitCode}): ${text}`,
          };
        }
      }),
    );

    const failure = lookups.find((l) => !l.ok);
    if (failure !== undefined && !failure.ok) {
      return failure;
    }

    return {
      ok: true,
      items: ids.map((id) => found.get(id) ?? { id, title: '', state: 'missing' as const }),
    };
  }

  async children(id: string): Promise<WorkLookup> {
    const { target, repo } = parseTarget(id, this.#repo);
    const args = [
      'issue',
      'view',
      target,
      '--json',
      'number,title,state,stateReason,body,subIssues',
    ];
    if (repo !== undefined) args.push('-R', repo);

    let result: RunResult;
    try {
      result = await this.#run(args);
    } catch (error) {
      return {
        ok: false,
        error: `could not run gh (${String(error)}); install it or set GH_BIN`,
      };
    }

    if (result.exitCode !== 0) {
      const text = (result.stderr || result.stdout).trim();
      if (NOT_FOUND.test(text)) {
        return { ok: false, error: `gh has no issue ${id}` };
      }
      return {
        ok: false,
        error: `gh issue view ${target} failed (exit ${result.exitCode}): ${text}`,
      };
    }

    try {
      const raw = JSON.parse(result.stdout) as Record<string, unknown>;

      // 1. Native subIssues if present in gh response
      if (Array.isArray(raw.subIssues) && raw.subIssues.length > 0) {
        const items: WorkItem[] = raw.subIssues.map((sub: Record<string, unknown>) => {
          const num = String(sub.number ?? sub.id ?? '');
          const rawState = String(sub.state ?? '');
          return {
            id: `#${num}`,
            title: String(sub.title ?? ''),
            state: mapGhState(rawState, sub.stateReason as string | null | undefined),
            rawState,
          };
        });
        return { ok: true, items };
      }

      // 2. Checklist items in issue body
      const body = typeof raw.body === 'string' ? raw.body : '';
      const items: WorkItem[] = [];
      const checklistRegex = /^[-*]\s+\[([ xX])\]\s+(?:#?(\d+)\s+)?(.*)$/gm;
      let match: RegExpExecArray | null = checklistRegex.exec(body);
      let index = 1;
      while (match !== null) {
        const mark = match[1] ?? ' ';
        const isChecked = mark.toLowerCase() === 'x';
        const issueNum = match[2];
        const text = match[3]?.trim() ?? '';
        const childId = issueNum !== undefined ? `#${issueNum}` : `${id}.${index}`;
        items.push({
          id: childId,
          title: text || (issueNum !== undefined ? `Issue #${issueNum}` : `Task ${index}`),
          state: isChecked ? 'closed' : 'open',
          rawState: isChecked ? 'CLOSED' : 'OPEN',
        });
        index++;
        match = checklistRegex.exec(body);
      }

      return { ok: true, items };
    } catch {
      const text = (result.stderr || result.stdout).trim();
      return {
        ok: false,
        error: `gh did not answer in JSON (exit ${result.exitCode}): ${text}`,
      };
    }
  }

  async close(id: string, reason: string): Promise<WorkChange> {
    const { target, repo } = parseTarget(id, this.#repo);
    const args = ['issue', 'close', target];
    if (reason) args.push('--comment', reason);
    if (repo !== undefined) args.push('-R', repo);
    return this.#change('close', target, args);
  }

  async reopen(id: string, reason: string): Promise<WorkChange> {
    const { target, repo } = parseTarget(id, this.#repo);
    const args = ['issue', 'reopen', target];
    if (reason) args.push('--comment', reason);
    if (repo !== undefined) args.push('-R', repo);
    return this.#change('reopen', target, args);
  }

  async create(options: {
    readonly title: string;
    readonly parent?: string | undefined;
    readonly description?: string | undefined;
  }): Promise<WorkCreateResult> {
    const { repo: parentRepo, target: parentTarget } = options.parent
      ? parseTarget(options.parent, this.#repo)
      : { repo: this.#repo, target: undefined };
    const repo = parentRepo ?? this.#repo;
    const args = ['issue', 'create', '--title', options.title];
    if (options.description) args.push('--body', options.description);
    else args.push('--body', '');
    if (parentTarget !== undefined) args.push('--parent', parentTarget);
    if (repo !== undefined) args.push('-R', repo);

    let result: RunResult;
    try {
      result = await this.#run(args);
    } catch (error) {
      return {
        ok: false,
        error: `could not run gh (${String(error)}); install it or set GH_BIN`,
      };
    }

    if (result.exitCode !== 0) {
      const text = (result.stderr || result.stdout).trim();
      return {
        ok: false,
        error: `gh issue create failed (exit ${result.exitCode}): ${text}`,
      };
    }

    // gh issue create prints the URL of the created issue, e.g. https://github.com/owner/repo/issues/123
    const output = (result.stdout || result.stderr).trim();
    const urlMatch = output.match(/\/issues\/(\d+)/);
    if (urlMatch !== null && urlMatch[1] !== undefined) {
      return { ok: true, id: `#${urlMatch[1]}` };
    }

    // Fallback: check if JSON was emitted
    if (output.startsWith('{')) {
      const numMatchJson = output.match(/"number"\s*:\s*(\d+)/);
      if (numMatchJson !== null && numMatchJson[1] !== undefined) {
        return { ok: true, id: `#${numMatchJson[1]}` };
      }
    }

    // Fallback: bare number or #number
    const numMatch = output.match(/#?(\d+)/);
    if (numMatch !== null && numMatch[1] !== undefined) {
      return { ok: true, id: `#${numMatch[1]}` };
    }

    return {
      ok: false,
      error: `gh issue create answered without an issue number: ${output}`,
    };
  }

  async #change(verb: string, target: string, args: readonly string[]): Promise<WorkChange> {
    let result: RunResult;
    try {
      result = await this.#run(args);
    } catch (error) {
      return {
        ok: false,
        error: `could not run gh (${String(error)}); install it or set GH_BIN`,
      };
    }
    if (result.exitCode === 0) return { ok: true };
    const text = (result.stderr || result.stdout).trim();
    return {
      ok: false,
      error: `gh issue ${verb} ${target} failed (exit ${result.exitCode}): ${text}`,
    };
  }
}
