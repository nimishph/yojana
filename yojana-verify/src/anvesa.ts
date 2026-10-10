import {
  type Claim,
  type ClaimResult,
  evaluatePredicate,
  type RequirementId,
  type VerifierDescriptor,
  type VerifierPort,
} from '@cntxt-labs/yojana-core';
import { listed } from './evidence.ts';

/**
 * Claims checked through the anvesa CLI (https://github.com/nimishph/anvesa), run as a child
 * process with `--json` against the repository's own anvesa index.
 *
 *   kind: anvesa.wql (alias: wql)
 *                      expression: <wql> [in <dir>]
 *                      holds when "it matches something" (only in files under <dir>, if given)
 *                      == expect. anvesa's WQL selects syntax, not places, so the folder filter
 *                      is applied here to every match.
 *   kind: anvesa.dependents (alias: dependents)
 *                      expression: <path> [from <dir>]
 *                      holds when "something imports <path>" (only importers under <dir>, if given)
 *                      == expect. `cli/src/index.ts from core/` with expect: false says core never
 *                      imports the CLI.
 *   kind: anvesa.callers
 *                      symbol / target: <symbol-name-or-path:line>
 *                      measures callers count, e.g. dead code: count == 0.
 *   kind: anvesa.callees
 *                      symbol / target: <symbol-name-or-path:line>
 *                      measures callees count.
 *   kind: anvesa.routes
 *                      method, path, framework
 *                      measures discovered endpoint routes count.
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
  | { readonly ok: true; readonly value: Record<string, unknown> | readonly unknown[] }
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
    return { ok: false, why: 'anvesa answered with something other than an object or array' };
  }
  if (Array.isArray(value)) {
    return { ok: true, value };
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
  readonly kinds = [
    'anvesa.wql',
    'wql',
    'anvesa.dependents',
    'dependents',
    'anvesa.callers',
    'anvesa.callees',
    'anvesa.routes',
  ] as const;
  readonly #run: AnvesaRunner;

  constructor(run: AnvesaRunner) {
    this.#run = run;
  }

  describe(): VerifierDescriptor {
    return {
      name: 'anvesa',
      version: '1.0.0',
      kinds: [
        {
          kind: 'anvesa.wql',
          description: 'Syntactic queries over AST',
          expression: true,
          params: {
            query: { type: 'string', required: false, description: 'WQL query expression' },
            within: { type: 'string', required: false, description: 'Folder scope filter' },
          },
          deterministic: true,
          version: '1.0.0',
        },
        {
          kind: 'wql',
          description: 'Syntactic queries over AST (alias for anvesa.wql)',
          expression: true,
          params: {
            query: { type: 'string', required: false, description: 'WQL query expression' },
            within: { type: 'string', required: false, description: 'Folder scope filter' },
          },
          deterministic: true,
          version: '1.0.0',
        },
        {
          kind: 'anvesa.dependents',
          description: 'Dependency graph import checks',
          expression: true,
          params: {
            target: { type: 'string', required: false, description: 'Target file path' },
            from: { type: 'string', required: false, description: 'Importer folder scope filter' },
          },
          deterministic: true,
          version: '1.0.0',
        },
        {
          kind: 'dependents',
          description: 'Dependency graph import checks (alias for anvesa.dependents)',
          expression: true,
          params: {
            target: { type: 'string', required: false, description: 'Target file path' },
            from: { type: 'string', required: false, description: 'Importer folder scope filter' },
          },
          deterministic: true,
          version: '1.0.0',
        },
        {
          kind: 'anvesa.callers',
          description: 'Trace callers of a symbol or location',
          expression: true,
          params: {
            symbol: {
              type: 'string',
              required: false,
              description: 'Target symbol name or path:line',
            },
            target: {
              type: 'string',
              required: false,
              description: 'Target symbol name or path:line',
            },
            resolvedOnly: {
              type: 'boolean',
              required: false,
              description: 'Include only resolved call edges',
            },
          },
          deterministic: true,
          version: '1.0.0',
        },
        {
          kind: 'anvesa.callees',
          description: 'Trace callees invoked by a symbol or location',
          expression: true,
          params: {
            symbol: {
              type: 'string',
              required: false,
              description: 'Target symbol name or path:line',
            },
            target: {
              type: 'string',
              required: false,
              description: 'Target symbol name or path:line',
            },
          },
          deterministic: true,
          version: '1.0.0',
        },
        {
          kind: 'anvesa.routes',
          description: 'Discovered HTTP endpoint routes',
          expression: true,
          params: {
            method: {
              type: 'string',
              required: false,
              description: 'HTTP method filter (GET, POST, etc.)',
            },
            path: {
              type: 'string',
              required: false,
              description: 'Route path template filter',
            },
            framework: {
              type: 'string',
              required: false,
              description: 'Framework filter',
            },
          },
          deterministic: true,
          version: '1.0.0',
        },
      ],
    };
  }

  async indexState(): Promise<string | undefined> {
    try {
      const output = await this.#run(['status']);
      const parsed = parseOutput(output);
      if (parsed.ok && !Array.isArray(parsed.value)) {
        const obj = parsed.value as Record<string, unknown>;
        const idx = obj.index as Record<string, unknown> | undefined;
        if (idx !== undefined) {
          return `${String(idx.symbols ?? '')}:${String(idx.calls ?? '')}:${String(idx.files ?? '')}`;
        }
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  async verify(requirement: RequirementId, claim: Claim): Promise<ClaimResult> {
    const result = (
      outcome: ClaimResult['outcome'],
      evidence: string,
      measurements?: Record<string, unknown>,
    ): ClaimResult => ({
      requirement,
      claim,
      outcome,
      evidence,
      measurements,
      deterministic: true,
    });

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

    if (claim.kind === 'wql' || claim.kind === 'anvesa.wql') {
      const split = splitWql(claim.expression ?? '');
      const within = (claim.params?.within as string | undefined) ?? split.within;
      const rec = !Array.isArray(parsed.value) ? (parsed.value as Record<string, unknown>) : {};
      const items = (Array.isArray(rec.items) ? rec.items : []).map(
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
      const count = places.length;
      const evidence =
        count > 0 ? `matches${scope} ${listed(places)}${overall}` : `no match${scope}${overall}`;
      const measurements = { count, matches: places };
      const outcome = evaluatePredicate(claim.expect, measurements) ? 'holds' : 'violated';
      return result(outcome, evidence, measurements);
    }

    if (claim.kind === 'dependents' || claim.kind === 'anvesa.dependents') {
      const split = splitDependents(claim.expression ?? '');
      const from = (claim.params?.from as string | undefined) ?? split.from;
      const rec = !Array.isArray(parsed.value) ? (parsed.value as Record<string, unknown>) : {};
      const all = Array.isArray(rec.dependents) ? rec.dependents : [];
      const paths = all
        .map((d) => String((d as Record<string, unknown>).path))
        .filter((path) => from === undefined || path.startsWith(from));
      const scope = from === undefined ? '' : ` under ${from}`;
      const overall =
        from === undefined
          ? ''
          : ` (${all.length} ${all.length === 1 ? 'file imports' : 'files import'} it in all)`;
      const count = paths.length;
      const countDesc = `${count} ${count === 1 ? 'file' : 'files'}`;
      const evidence =
        count > 0
          ? `imported${scope} by ${listed(paths)} (${countDesc})${overall}`
          : `nothing${scope} imports it${overall}`;
      const measurements = { count, matches: paths };
      const outcome = evaluatePredicate(claim.expect, measurements) ? 'holds' : 'violated';
      return result(outcome, evidence, measurements);
    }

    if (claim.kind === 'anvesa.callers') {
      const rec = !Array.isArray(parsed.value) ? (parsed.value as Record<string, unknown>) : {};
      const callersObj = rec.callers as Record<string, unknown> | undefined;
      const items = Array.isArray(callersObj?.items)
        ? (callersObj.items as readonly Record<string, unknown>[])
        : [];
      const count = items.length;
      const callerNames = items.map((c) => String(c.from ?? `${c.path}:${c.line}`));
      const sym = rec.symbol as Record<string, unknown> | undefined;
      const symName = sym?.name
        ? String(sym.name)
        : String(claim.params?.symbol ?? claim.params?.target ?? claim.expression ?? 'symbol');
      const evidence =
        count === 0
          ? `no callers for ${symName}`
          : `called by ${listed(callerNames)} (${count} ${count === 1 ? 'caller' : 'callers'})`;
      const measurements = { count, callers: callerNames };
      const outcome = evaluatePredicate(claim.expect, measurements) ? 'holds' : 'violated';
      return result(outcome, evidence, measurements);
    }

    if (claim.kind === 'anvesa.callees') {
      const rec = !Array.isArray(parsed.value) ? (parsed.value as Record<string, unknown>) : {};
      const calleesObj = rec.callees as Record<string, unknown> | undefined;
      const items = Array.isArray(calleesObj?.items)
        ? (calleesObj.items as readonly Record<string, unknown>[])
        : [];
      const count = items.length;
      const calleeNames = items.map((c) => String(c.to ?? `${c.path}:${c.line}`));
      const sym = rec.symbol as Record<string, unknown> | undefined;
      const symName = sym?.name
        ? String(sym.name)
        : String(claim.params?.symbol ?? claim.params?.target ?? claim.expression ?? 'symbol');
      const evidence =
        count === 0
          ? `no callees for ${symName}`
          : `calls ${listed(calleeNames)} (${count} ${count === 1 ? 'callee' : 'callees'})`;
      const measurements = { count, callees: calleeNames };
      const outcome = evaluatePredicate(claim.expect, measurements) ? 'holds' : 'violated';
      return result(outcome, evidence, measurements);
    }

    if (claim.kind === 'anvesa.routes') {
      const rec = !Array.isArray(parsed.value) ? (parsed.value as Record<string, unknown>) : {};
      const items = Array.isArray(parsed.value)
        ? (parsed.value as readonly Record<string, unknown>[])
        : Array.isArray(rec.items)
          ? (rec.items as readonly Record<string, unknown>[])
          : [];
      const count = items.length;
      const routeDescs = items.map((r) =>
        `${String(r.method ?? '')} ${String(r.route ?? r.path ?? '')}`.trim(),
      );
      const evidence =
        count === 0
          ? 'no matching routes'
          : `routes: ${listed(routeDescs)} (${count} ${count === 1 ? 'route' : 'routes'})`;
      const measurements = { count, routes: routeDescs };
      const outcome = evaluatePredicate(claim.expect, measurements) ? 'holds' : 'violated';
      return result(outcome, evidence, measurements);
    }

    return result('unverifiable', `unsupported anvesa claim kind "${claim.kind}"`);
  }

  #args(claim: Claim): string[] {
    if (claim.kind === 'wql' || claim.kind === 'anvesa.wql') {
      const split = splitWql(claim.expression ?? '');
      const query = (claim.params?.query as string | undefined) ?? split.query;
      const within = (claim.params?.within as string | undefined) ?? split.within;
      const limit = within === undefined ? 1 : Number.MAX_SAFE_INTEGER;
      return ['query', query, '--limit', String(limit)];
    }
    if (claim.kind === 'dependents' || claim.kind === 'anvesa.dependents') {
      const split = splitDependents(claim.expression ?? '');
      const target =
        (claim.params?.target as string | undefined) ??
        (claim.params?.path as string | undefined) ??
        split.target;
      return [
        'dependents',
        target,
        '--depth',
        String(Number.MAX_SAFE_INTEGER),
        '--limit',
        String(Number.MAX_SAFE_INTEGER),
      ];
    }
    if (claim.kind === 'anvesa.callers') {
      const target =
        (claim.params?.symbol as string | undefined) ??
        (claim.params?.target as string | undefined) ??
        claim.expression?.trim() ??
        '';
      const args = ['callers', target, '--limit', String(Number.MAX_SAFE_INTEGER)];
      if (claim.params?.resolvedOnly === true) {
        args.push('--resolved-only');
      }
      return args;
    }
    if (claim.kind === 'anvesa.callees') {
      const target =
        (claim.params?.symbol as string | undefined) ??
        (claim.params?.target as string | undefined) ??
        claim.expression?.trim() ??
        '';
      return ['callees', target, '--limit', String(Number.MAX_SAFE_INTEGER)];
    }
    if (claim.kind === 'anvesa.routes') {
      const parsedExpr = splitRoutes(claim.expression ?? '');
      const method = (claim.params?.method as string | undefined) ?? parsedExpr.method;
      const path = (claim.params?.path as string | undefined) ?? parsedExpr.path;
      const framework = claim.params?.framework as string | undefined;
      const args = ['routes'];
      if (method !== undefined) args.push(method);
      if (path !== undefined) args.push(path);
      if (framework !== undefined) args.push('--framework', framework);
      return args;
    }
    return [claim.kind, claim.expression ?? ''];
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

function splitRoutes(expression: string): {
  method: string | undefined;
  path: string | undefined;
} {
  const trimmed = expression.trim();
  if (trimmed === '') return { method: undefined, path: undefined };
  const parts = trimmed.split(/\s+/);
  const first = parts[0];
  if (first !== undefined && parts.length >= 2) {
    const isMethod = /^(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD|ANY)$/i.test(first);
    if (isMethod) {
      return { method: first.toUpperCase(), path: parts.slice(1).join(' ') };
    }
    return { method: undefined, path: trimmed };
  }
  if (/^(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD|ANY)$/i.test(trimmed)) {
    return { method: trimmed.toUpperCase(), path: undefined };
  }
  return { method: undefined, path: trimmed };
}
