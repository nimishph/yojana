import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Claim, ClaimResult, RequirementId, VerifierPort } from '@cntxt-labs/yojana-core';
import { listed } from './evidence.ts';

/**
 * `kind: path` claims, checked on the filesystem: the expression is a path or a glob relative to
 * the repository root, and the claim holds when "something matches" == expect.
 *
 *   kind: path
 *   expression: .claude-plugin/plugin.json
 */
export class PathVerifier implements VerifierPort {
  readonly name = 'path';
  readonly kinds = ['path'] as const;
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async verify(requirement: RequirementId, claim: Claim): Promise<ClaimResult> {
    const pattern = claim.expression.trim();
    const isGlob = /[*?[{]/.test(pattern);
    const matches = isGlob
      ? Array.from(new Bun.Glob(pattern).scanSync({ cwd: this.#root, dot: true }))
      : existsSync(join(this.#root, pattern))
        ? [pattern]
        : [];
    const found = matches.length > 0;
    return {
      requirement,
      claim,
      outcome: found === claim.expect ? 'holds' : 'violated',
      evidence: found
        ? `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}: ${listed(matches.sort())}`
        : `${pattern} does not exist`,
    };
  }
}
