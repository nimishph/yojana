import {
  type Claim,
  type ClaimResult,
  evaluateClaimOutcome,
  type RequirementId,
  type VerifierDescriptor,
  type VerifierPort,
} from '@cntxt-labs/yojana-core';
import type { RunResult } from './anvesa.ts';

/**
 * External verifier adapter speaking JSON over stdio.
 *
 * Protocol:
 *   1. describe -> child process invoked with 'describe' argument and {"action":"describe"} on stdin.
 *      Returns VerifierDescriptor JSON on stdout: { name, version?, kinds: [{ kind, description?, params?, deterministic, version? }] }
 *   2. verify -> child process invoked with 'verify' argument and {"action":"verify", "requirement", "claim"} on stdin.
 *      Returns ClaimResult JSON on stdout: { outcome?, evidence, measurements?, deterministic?, measuredAt? }
 *   3. indexState -> (optional) child process invoked with 'indexState' argument and {"action":"indexState"} on stdin.
 *      Returns { "indexState": string } or string on stdout.
 */

export type StdioAction = 'describe' | 'verify' | 'indexState';

export type StdioRunner = (
  action: StdioAction,
  payload: Record<string, unknown>,
) => Promise<RunResult>;

export interface ExternalVerifierOptions {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly kinds?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export function spawnExternal(options: {
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
}): StdioRunner {
  return async (action, payload) => {
    const input = JSON.stringify(payload);
    const cmdArgs = [...(options.args ?? []), action];
    const spawnOpts: {
      cwd?: string;
      env: Record<string, string | undefined>;
      stdin: 'pipe';
      stdout: 'pipe';
      stderr: 'pipe';
    } = {
      env: { ...process.env, ...(options.env ?? {}) },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    };
    if (options.cwd !== undefined) {
      spawnOpts.cwd = options.cwd;
    }
    const child = Bun.spawn([options.command, ...cmdArgs], spawnOpts);
    if (child.stdin) {
      await child.stdin.write(input);
      await child.stdin.end();
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  };
}

export class ExternalVerifier implements VerifierPort {
  readonly name: string;
  #kinds: string[];
  #descriptor?: VerifierDescriptor | undefined;
  readonly #run: StdioRunner;

  constructor(options: ExternalVerifierOptions, run?: StdioRunner) {
    this.name = options.name;
    this.#kinds = options.kinds ? [...options.kinds] : [];
    this.#run = run ?? spawnExternal(options);
  }

  get kinds(): readonly string[] {
    return this.#kinds;
  }

  async describe(): Promise<VerifierDescriptor> {
    if (this.#descriptor !== undefined) {
      return this.#descriptor;
    }
    let output: RunResult;
    try {
      output = await this.#run('describe', { action: 'describe' });
    } catch {
      return {
        name: this.name,
        kinds: this.#kinds.map((k) => ({
          kind: k,
          expression: true,
          deterministic: true,
        })),
      };
    }
    if (output.exitCode !== 0) {
      return {
        name: this.name,
        kinds: this.#kinds.map((k) => ({
          kind: k,
          expression: true,
          deterministic: true,
        })),
      };
    }
    try {
      const parsed = JSON.parse(output.stdout) as Partial<VerifierDescriptor>;
      const kinds = Array.isArray(parsed.kinds) ? parsed.kinds : [];
      this.#descriptor = {
        name: typeof parsed.name === 'string' ? parsed.name : this.name,
        version: typeof parsed.version === 'string' ? parsed.version : undefined,
        kinds,
      };
      this.#kinds = kinds.map((k) => k.kind);
      return this.#descriptor;
    } catch {
      return {
        name: this.name,
        kinds: this.#kinds.map((k) => ({
          kind: k,
          expression: true,
          deterministic: true,
        })),
      };
    }
  }

  async indexState(): Promise<string | undefined> {
    try {
      const output = await this.#run('indexState', { action: 'indexState' });
      if (output.exitCode !== 0) return undefined;
      const parsed = JSON.parse(output.stdout);
      if (typeof parsed === 'string') return parsed;
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.indexState === 'string') {
        return parsed.indexState;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  async verify(requirement: RequirementId, claim: Claim): Promise<ClaimResult> {
    let output: RunResult;
    try {
      output = await this.#run('verify', {
        action: 'verify',
        requirement,
        claim,
      });
    } catch (err) {
      return {
        requirement,
        claim,
        outcome: 'unverifiable',
        evidence: `could not run external verifier "${this.name}": ${(err as Error).message}`,
      };
    }

    if (output.exitCode !== 0) {
      const text = (output.stderr || output.stdout).trim();
      return {
        requirement,
        claim,
        outcome: 'unverifiable',
        evidence: `external verifier "${this.name}" failed (exit ${output.exitCode}): ${text}`,
      };
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(output.stdout);
    } catch {
      const text = output.stdout.trim();
      return {
        requirement,
        claim,
        outcome: 'unverifiable',
        evidence: `external verifier "${this.name}" did not answer in JSON: ${text}`,
      };
    }

    const measurements =
      parsed.measurements !== null && typeof parsed.measurements === 'object'
        ? (parsed.measurements as Record<string, unknown>)
        : undefined;

    let outcome: ClaimResult['outcome'] =
      parsed.outcome === 'holds' ||
      parsed.outcome === 'violated' ||
      parsed.outcome === 'unverifiable'
        ? parsed.outcome
        : 'holds';

    if (measurements !== undefined) {
      outcome = evaluateClaimOutcome(claim, { outcome, measurements });
    }

    const evidence = typeof parsed.evidence === 'string' ? parsed.evidence : '';
    const descKind = this.#descriptor?.kinds.find((k) => k.kind === claim.kind);
    const deterministic =
      typeof parsed.deterministic === 'boolean'
        ? parsed.deterministic
        : (descKind?.deterministic ?? true);

    const measuredAt =
      typeof parsed.measuredAt === 'number'
        ? parsed.measuredAt
        : deterministic
          ? undefined
          : Date.now();

    return {
      requirement,
      claim,
      outcome,
      evidence,
      measurements,
      deterministic,
      ...(measuredAt !== undefined ? { measuredAt } : {}),
    };
  }
}
