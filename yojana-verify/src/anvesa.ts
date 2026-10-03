import type { Claim, ClaimResult, RequirementId, VerifierPort } from '@cntxt-labs/yojana-core';
import { listed } from './evidence.ts';

/**
 * Claims checked through the anvesa CLI (https://github.com/nimishph/anvesa), run as a child
 * process with `--json` against the repository's own anvesa index.
 *
 *   kind: wql          expression: <wql> [in <dir>]
 *                      holds when "it matches something" (only in files under <dir>, if given)
 *                      == expect. anvesa's WQL selects syntax, not places, so the folder filter
 *                      is applied here to every match.
 *   kind: dependents   expression: <path> [from <dir>]
 *                      holds when "something imports <path>" (only importers under <dir>, if given)
 *                      == expect. `cli/src/index.ts from core/` with expect: false says core never
 *                      imports the CLI.
 *
 * Whatever stops a check from running (anvesa missing, no index, an invalid query, output that is
 * not JSON) makes the claim unverifiable with anvesa's own message. It never counts as holding.
 */

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs anvesa with arguments; throws when the program cannot be started at all. */
export type AnvesaRunner = (args: readonly string[]) => Promise<RunResult>;

export function spawnAnvesa(bin: string, root: string): AnvesaRunner {
  return async (args) => {
    const child = Bun.spawn([bin, ...args, '--root', root, '--json'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  };
}

type Parsed =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly why: string };

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** anvesa answers on stdout, and reports a failure as JSON on stderr with a non-zero exit. */
function parseOutput(result: RunResult): Parsed {
  const value = parseJson(result.stdout) ?? parseJson(result.stderr);
  if (value === undefined) {
    const text = (result.stderr || result.stdout).trim();
    return { ok: false, why: `anvesa did not answer in JSON (exit ${result.exitCode}): ${text}` };
  }
  if (typeof value !== 'object' || value === null) {
    return { ok: false, why: 'anvesa answered with something other than an object' };
  }
  const record = value as Record<string, unknown>;
  const error = record.error as Record<string, unknown> | undefined;
  if (error !== undefined) {
    const hint = typeof error.hint === 'string' ? ` (${error.hint})` : '';
    return { ok: false, why: `${String(error.code)}: ${String(error.message)}${hint}` };
  }
  return { ok: true, value: record };
}

export class AnvesaVerifier implements VerifierPort {
  readonly name = 'anvesa';
  readonly kinds = ['wql', 'dependents'] as const;
  readonly #run: AnvesaRunner;

  constructor(run: AnvesaRunner) {
    this.#run = run;
  }

  async verify(requirement: RequirementId, claim: Claim): Promise<ClaimResult> {
    const result = (outcome: ClaimResult['outcome'], evidence: string): ClaimResult => ({
      requirement,
      claim,
      outcome,
      evidence,
    });
    const judge = (found: boolean, evidence: string) =>
      result(found === claim.expect ? 'holds' : 'violated', evidence);

    let output: RunResult;
    try {
      output = await this.#run(this.#args(claim));
    } catch (error) {
      return result(
        'unverifiable',
        `could not run anvesa (${String(error)}); install it or set ANVESA_BIN`,
      );
    }
    const parsed = parseOutput(output);
    if (!parsed.ok) return result('unverifiable', parsed.why);

    if (claim.kind === 'wql') {
      const { within } = splitWql(claim.expression);
      const items = (Array.isArray(parsed.value.items) ? parsed.value.items : []).map(
        (item) => item as Record<string, unknown>,
      );
      const places = items
        .filter((i) => within === undefined || String(i.path).startsWith(within))
        .map((i) => `${String(i.path)}:${String(i.startLine)}`);
      const scope = within === undefined ? '' : ` in ${within}`;
      const overall =
        within === undefined
          ? ''
          : ` (${items.length} ${items.length === 1 ? 'match' : 'matches'} in all)`;
      return judge(
        places.length > 0,
        places.length > 0
          ? `matches${scope} ${listed(places)}${overall}`
          : `no match${scope}${overall}`,
      );
    }

    const { from } = splitDependents(claim.expression);
    const all = Array.isArray(parsed.value.dependents) ? parsed.value.dependents : [];
    const paths = all
      .map((d) => String((d as Record<string, unknown>).path))
      .filter((path) => from === undefined || path.startsWith(from));
    const scope = from === undefined ? '' : ` under ${from}`;
    // With a scope, say how many import it overall, so "nothing under core/" is not mistaken for
    // a check that passed only because the path was wrong and nothing imports it at all.
    const overall =
      from === undefined
        ? ''
        : ` (${all.length} ${all.length === 1 ? 'file imports' : 'files import'} it in all)`;
    const count = `${paths.length} ${paths.length === 1 ? 'file' : 'files'}`;
    return judge(
      paths.length > 0,
      paths.length > 0
        ? `imported${scope} by ${listed(paths)} (${count})${overall}`
        : `nothing${scope} imports it${overall}`,
    );
  }

  #args(claim: Claim): string[] {
    if (claim.kind === 'wql') {
      const { query, within } = splitWql(claim.expression);
      // Unscoped, one match decides it. Scoped, every match is needed to filter by folder.
      const limit = within === undefined ? 1 : Number.MAX_SAFE_INTEGER;
      return ['query', query, '--limit', String(limit)];
    }
    const { target } = splitDependents(claim.expression);
    // Every importer at every depth: the claim is about all of them, so nothing is cut off.
    return [
      'dependents',
      target,
      '--depth',
      String(Number.MAX_SAFE_INTEGER),
      '--limit',
      String(Number.MAX_SAFE_INTEGER),
    ];
  }
}

/** `<wql> in <dir>`: only matches in files under <dir> count. */
function splitWql(expression: string): { query: string; within: string | undefined } {
  // The folder is the last word, with no brackets or quotes, so `[@name="a in b"]` is not split.
  const match = /^(.+)\s+in\s+([^\s[\]()"']+)$/.exec(expression.trim());
  if (match === null) return { query: expression.trim(), within: undefined };
  return { query: (match[1] ?? '').trim(), within: match[2] };
}

function splitDependents(expression: string): { target: string; from: string | undefined } {
  const match = /^(.*?)\s+from\s+(\S+)$/.exec(expression.trim());
  if (match === null) return { target: expression.trim(), from: undefined };
  return { target: (match[1] ?? '').trim(), from: match[2] };
}
