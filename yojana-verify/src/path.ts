import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Claim,
  type ClaimResult,
  evaluateClaimOutcome,
  type RequirementId,
  type VerifierPort,
} from '@cntxt-labs/yojana-core';
import { listed } from './evidence.ts';

/**
 * `kind: path` claims, checked on the filesystem: the expression is a path or a glob relative to
 * the repository root, and the claim holds when "something matches" == expect.
 *
 *   kind: path
 *   expression: .claude-plugin/plugin.json
 *
 * Or structured with params and predicates:
 *   kind: path
 *   path: src/*.ts
 *   expect:
 *     gte: 1
 */
export class PathVerifier implements VerifierPort {
  readonly name = 'path';
  readonly kinds = ['path'] as const;
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  describe() {
    return {
      name: 'path',
      version: '1.0.0',
      kinds: [
        {
          kind: 'path',
          description: 'Checks if a path or glob matches on filesystem',
          expression: true,
          params: {
            path: { type: 'string' as const, required: false, description: 'File path to check' },
            glob: {
              type: 'string' as const,
              required: false,
              description: 'Glob pattern to check',
            },
          },
          deterministic: true,
          version: '1.0.0',
        },
      ],
    };
  }

  async verify(requirement: RequirementId, claim: Claim): Promise<ClaimResult> {
    const pattern = (
      claim.expression ??
      (claim.params?.path as string) ??
      (claim.params?.glob as string) ??
      ''
    ).trim();
    if (pattern === '') {
      return {
        requirement,
        claim,
        outcome: 'unverifiable',
        evidence: 'claim needs an expression, path, or glob parameter',
      };
    }
    const isGlob = /[*?[{]/.test(pattern);
    const matches = isGlob
      ? Array.from(new Bun.Glob(pattern).scanSync({ cwd: this.#root, dot: true }))
      : existsSync(join(this.#root, pattern))
        ? [pattern]
        : [];
    const measurements = { count: matches.length, matches };
    const outcome = evaluateClaimOutcome(claim, { outcome: 'holds', measurements });
    return {
      requirement,
      claim,
      outcome,
      measurements,
      evidence:
        matches.length > 0
          ? `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}: ${listed(matches.sort())}`
          : `${pattern} does not exist`,
    };
  }
}
