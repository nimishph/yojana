import {
  type Claim,
  type ClaimResult,
  evaluatePredicate,
  type RequirementId,
  type RuleProposal,
  type RuleProposalResult,
  type RuleSinkPort,
  type VerifierDescriptor,
  type VerifierPort,
} from '@cntxt-labs/yojana-core';
import type { RunResult } from './anvesa.ts';

/**
 * Claims checked through the medha CLI (https://github.com/nimishph/medha), run as a child
 * process with `--json` against the repository's `.medha/` home.
 *
 *   kind: medha.entity
 *                      params: { entity: 'rule/x' (or 'x'), namespace? }
 *                      measures status, trust, drift via 'medha show --json'.
 *                      Lets a requirement say 'rule X is adopted and proven'
 *                      (status in [trusted, active], trust >= 0.7).
 *                      Non-deterministic: carries measuredAt timestamp.
 */

export type MedhaRunner = (args: readonly string[]) => Promise<RunResult>;

export function spawnMedha(bin: string, root: string): MedhaRunner {
  return async (args) => {
    const child = Bun.spawn([bin, ...args, '--dir', root, '--json'], {
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

function parseOutput(result: RunResult): Parsed {
  const value = parseJson(result.stdout) ?? parseJson(result.stderr);
  if (value === undefined) {
    const text = (result.stderr || result.stdout).trim();
    return { ok: false, why: `medha did not answer in JSON (exit ${result.exitCode}): ${text}` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, why: 'medha answered with something other than an object' };
  }
  const record = value as Record<string, unknown>;
  const error = record.error as Record<string, unknown> | undefined;
  if (error !== undefined) {
    const hint = typeof error.hint === 'string' ? ` (${error.hint})` : '';
    return { ok: false, why: `${String(error.code)}: ${String(error.message)}${hint}` };
  }
  return { ok: true, value: record };
}

export function parseEntityKey(
  expression?: string,
  params?: Readonly<Record<string, unknown>>,
): { kind: string; id: string; namespace: string | undefined } {
  const entityStr =
    (params?.entity as string | undefined) ??
    (params?.id as string | undefined) ??
    expression?.trim();

  const namespace = params?.namespace as string | undefined;
  const explicitKind = params?.kind as string | undefined;

  if (!entityStr) {
    return { kind: explicitKind ?? 'rule', id: '', namespace };
  }

  const slashIdx = entityStr.indexOf('/');
  if (slashIdx >= 0) {
    const kind = explicitKind ?? entityStr.slice(0, slashIdx);
    const id = entityStr.slice(slashIdx + 1);
    return { kind, id, namespace };
  }

  return { kind: explicitKind ?? 'rule', id: entityStr, namespace };
}

export class MedhaVerifier implements VerifierPort {
  readonly name = 'medha';
  readonly kinds = ['medha.entity'] as const;
  readonly #run: MedhaRunner;

  constructor(run: MedhaRunner) {
    this.#run = run;
  }

  describe(): VerifierDescriptor {
    return {
      name: 'medha',
      version: '1.0.0',
      kinds: [
        {
          kind: 'medha.entity',
          description: 'Entity trust, lifecycle status, and drift',
          expression: true,
          params: {
            entity: {
              type: 'string',
              required: false,
              description: 'Entity identifier in form kind/id or id',
            },
            kind: {
              type: 'string',
              required: false,
              description: 'Entity kind (rule, recipe, tool). Default: rule',
            },
            id: {
              type: 'string',
              required: false,
              description: 'Entity id',
            },
            namespace: {
              type: 'string',
              required: false,
              description: 'Entity namespace',
            },
          },
          deterministic: false,
          version: '1.0.0',
        },
      ],
    };
  }

  async verify(requirement: RequirementId, claim: Claim): Promise<ClaimResult> {
    const { kind, id, namespace } = parseEntityKey(claim.expression, claim.params);
    const entityLabel = namespace ? `${namespace}:${kind}/${id}` : `${kind}/${id}`;

    let output: RunResult;
    try {
      output = await this.#run(this.#args(claim));
    } catch (error) {
      return {
        requirement,
        claim,
        outcome: 'unverifiable',
        evidence: `could not run medha (${String(error)}); install it or set MEDHA_BIN`,
        deterministic: false,
        measuredAt: Date.now(),
      };
    }

    const parsed = parseOutput(output);
    if (!parsed.ok) {
      return {
        requirement,
        claim,
        outcome: 'unverifiable',
        evidence: parsed.why,
        deterministic: false,
        measuredAt: Date.now(),
      };
    }

    const rec = parsed.value;
    const detail = (rec.detail ?? {}) as Record<string, unknown>;
    const hint = (detail.hint ?? {}) as Record<string, unknown>;
    const temporal = (hint.temporal ?? {}) as Record<string, unknown>;
    const status = String(hint.status ?? 'probation');
    const trust = typeof hint.trustScore === 'number' ? hint.trustScore : 0;
    const isDrifting = temporal.isDrifting === true;
    const driftDelta = typeof temporal.driftDelta === 'number' ? temporal.driftDelta : 0;
    const driftDirection =
      typeof temporal.driftDirection === 'string' ? temporal.driftDirection : undefined;
    const known = detail.known !== false;

    let evidence = `${entityLabel} status is ${status}, trust is ${trust}`;
    if (isDrifting && driftDirection !== undefined) {
      evidence += `, drifting (${driftDirection})`;
    }
    if (!known) {
      evidence += ' (unknown entity, probation prior)';
    }

    const measurements: Record<string, unknown> = {
      status,
      trust,
      trustScore: trust,
      drift: isDrifting,
      driftDelta,
      ...(driftDirection !== undefined ? { driftDirection } : {}),
      known,
      found: known,
      count: known ? 1 : 0,
    };

    const outcome = evaluatePredicate(claim.expect, measurements) ? 'holds' : 'violated';
    const measuredAt = typeof rec.asOf === 'number' ? rec.asOf : Date.now();

    return {
      requirement,
      claim,
      outcome,
      evidence,
      measurements,
      deterministic: false,
      measuredAt,
    };
  }

  #args(claim: Claim): string[] {
    const { kind, id, namespace } = parseEntityKey(claim.expression, claim.params);
    const args = ['show', '--id', id, '--kind', kind];
    if (namespace !== undefined && namespace !== '') {
      args.push('--namespace', namespace);
    }
    return args;
  }
}

export interface MedhaRuleSinkOptions {
  readonly namespace?: string | undefined;
}

/**
 * RuleSink implementation for medha: proposes candidate rules via 'medha propose'.
 */
export class MedhaRuleSink implements RuleSinkPort {
  readonly name = 'medha';
  readonly #runner: MedhaRunner;
  readonly #namespace: string | undefined;

  constructor(runner: MedhaRunner, options?: MedhaRuleSinkOptions | undefined) {
    this.#runner = runner;
    this.#namespace = options?.namespace;
  }

  async propose(proposals: readonly RuleProposal[]): Promise<readonly RuleProposalResult[]> {
    const results: RuleProposalResult[] = [];
    for (const proposal of proposals) {
      const args = ['propose', '--kind', proposal.kind ?? 'rule', '--id', proposal.id];
      const ns = proposal.namespace ?? this.#namespace;
      if (ns !== undefined && ns !== '') {
        args.push('--namespace', ns);
      }
      if (proposal.source) {
        args.push('--source', proposal.source);
      }
      if (proposal.text) {
        args.push('--text', proposal.text);
      }
      if (proposal.evidence) {
        args.push('--evidence', proposal.evidence);
      }
      if (proposal.author) {
        args.push('--author', proposal.author);
      }
      if (proposal.note) {
        args.push('--note', proposal.note);
      }
      if (proposal.at !== undefined) {
        args.push('--at', String(proposal.at));
      }

      try {
        const runResult = await this.#runner(args);
        if (runResult.exitCode !== 0) {
          const parsed = parseOutput(runResult);
          const errorMsg = parsed.ok ? JSON.stringify(parsed.value) : parsed.why;
          results.push({
            id: proposal.id,
            ok: false,
            error: errorMsg,
          });
        } else {
          const parsed = parseOutput(runResult);
          results.push({
            id: proposal.id,
            ok: true,
            ...(parsed.ok ? { entity: parsed.value } : {}),
          });
        }
      } catch (error) {
        results.push({
          id: proposal.id,
          ok: false,
          error: (error as Error).message,
        });
      }
    }
    return results;
  }
}
