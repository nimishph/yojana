import type { WorkItem, WorkItemState, WorkLinkPort, WorkLookup } from '@cntxt-labs/yojana-core';

/**
 * WorkLinkPort for bd (beads, https://github.com/steveyegge/beads), run as a child process in the
 * repository whose `.beads/` holds the plan's work items.
 *
 *   get       `bd show <ids...> --json`: an array of the issues found. Ids bd does not know are
 *             left out of the array (with a note on stderr), so they come back `missing`; when
 *             none are found bd answers `{"error": "no issues found ..."}`.
 *   children  `bd list --parent <id> --all --json --limit 0`: every child, closed ones included.
 *
 * bd not installed, or answering in something other than JSON, is an error result, never an
 * empty list that would read as "no work".
 */

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs bd with arguments; throws when the program cannot be started at all. */
export type BdRunner = (args: readonly string[]) => Promise<RunResult>;

export function spawnBd(bin: string, cwd: string): BdRunner {
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

const STATES: Readonly<Record<string, WorkItemState>> = {
  open: 'open',
  in_progress: 'in-progress',
  blocked: 'blocked',
  closed: 'closed',
  deferred: 'deferred',
};

function toItem(raw: Record<string, unknown>): WorkItem {
  const rawState = String(raw.status);
  return {
    id: String(raw.id),
    title: String(raw.title ?? ''),
    state: STATES[rawState] ?? 'unknown',
    rawState,
  };
}

const NONE_FOUND = /no issues found/i;

export class BdWorkLink implements WorkLinkPort {
  readonly name = 'bd';
  readonly #run: BdRunner;

  constructor(run: BdRunner) {
    this.#run = run;
  }

  async get(ids: readonly string[]): Promise<WorkLookup> {
    if (ids.length === 0) return { ok: true, items: [] };
    const answer = await this.#call(['show', ...ids, '--json']);
    if (!answer.ok) return answer;
    const found = new Map<string, WorkItem>();
    if (Array.isArray(answer.value)) {
      for (const raw of answer.value) {
        const item = toItem(raw as Record<string, unknown>);
        found.set(item.id, item);
      }
    } else {
      const error = (answer.value as Record<string, unknown> | null)?.error;
      if (!(typeof error === 'string' && NONE_FOUND.test(error))) {
        return {
          ok: false,
          error: `bd show answered unexpectedly: ${JSON.stringify(answer.value)}`,
        };
      }
    }
    return {
      ok: true,
      items: ids.map((id) => found.get(id) ?? { id, title: '', state: 'missing' as const }),
    };
  }

  async children(id: string): Promise<WorkLookup> {
    const answer = await this.#call(['list', '--parent', id, '--all', '--json', '--limit', '0']);
    if (!answer.ok) return answer;
    if (!Array.isArray(answer.value)) {
      return { ok: false, error: `bd list answered unexpectedly: ${JSON.stringify(answer.value)}` };
    }
    return { ok: true, items: answer.value.map((raw) => toItem(raw as Record<string, unknown>)) };
  }

  async #call(
    args: readonly string[],
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    let result: RunResult;
    try {
      result = await this.#run(args);
    } catch (error) {
      return { ok: false, error: `could not run bd (${String(error)}); install it or set BD_BIN` };
    }
    try {
      return { ok: true, value: JSON.parse(result.stdout) };
    } catch {
      const text = (result.stderr || result.stdout).trim();
      return { ok: false, error: `bd did not answer in JSON (exit ${result.exitCode}): ${text}` };
    }
  }
}
