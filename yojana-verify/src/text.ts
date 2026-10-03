import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Claim, ClaimResult, RequirementId, VerifierPort } from '@cntxt-labs/yojana-core';
import { listed } from './evidence.ts';

/**
 * `kind: text` claims: a pattern appears in files, checked by reading them.
 *
 *   kind: text
 *   expression: darwin-x64 in tooling/platforms.ts
 *   expression: /console\.log\(/ in src/**\/*.ts      (with expect: false: none left in src)
 *
 * The pattern is a regular expression; `/.../flags` sets flags. The part after the last ` in ` is
 * a path or glob from the repository root. The claim holds when "some line matches" == expect.
 * When the path or glob matches no file, the claim is unverifiable: "no match in nothing" would
 * pass any `expect: false` claim and prove nothing.
 */
export class TextVerifier implements VerifierPort {
  readonly name = 'text';
  readonly kinds = ['text'] as const;
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async verify(requirement: RequirementId, claim: Claim): Promise<ClaimResult> {
    const result = (outcome: ClaimResult['outcome'], evidence: string): ClaimResult => ({
      requirement,
      claim,
      outcome,
      evidence,
    });

    const split = /^(.+)\s+in\s+(\S+)$/.exec(claim.expression.trim());
    if (split === null) {
      return result('unverifiable', 'write the claim as `<pattern> in <path or glob>`');
    }
    const [, patternText = '', where = ''] = split;
    let pattern: RegExp;
    try {
      pattern = toRegExp(patternText.trim());
    } catch (error) {
      return result('unverifiable', `not a valid pattern: ${String(error)}`);
    }

    const files = this.#files(where);
    if (files.length === 0) return result('unverifiable', `no file matches ${where}`);

    const hits: string[] = [];
    for (const file of files) {
      const lines = readFileSync(join(this.#root, file), 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        pattern.lastIndex = 0;
        if (pattern.test(line)) hits.push(`${file}:${index + 1}`);
      });
    }
    const searched = `${files.length} ${files.length === 1 ? 'file' : 'files'} searched`;
    const found = hits.length > 0;
    return result(
      found === claim.expect ? 'holds' : 'violated',
      found
        ? `found at ${listed(hits)} (${hits.length} ${hits.length === 1 ? 'line' : 'lines'}, ${searched})`
        : `not found (${searched})`,
    );
  }

  #files(where: string): string[] {
    if (/[*?[{]/.test(where)) {
      return Array.from(new Bun.Glob(where).scanSync({ cwd: this.#root, dot: true }))
        .map((f) => f.split('\\').join('/'))
        .sort();
    }
    const path = join(this.#root, where);
    return existsSync(path) && statSync(path).isFile() ? [where] : [];
  }
}

/** `/source/flags` as written, or the whole text as a pattern with no flags. */
function toRegExp(text: string): RegExp {
  const literal = /^\/(.+)\/([a-z]*)$/.exec(text);
  return literal === null ? new RegExp(text) : new RegExp(literal[1] ?? '', literal[2]);
}
