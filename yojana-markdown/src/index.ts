import type { ParseResult, ParserPort, Plan } from '@cntxt-labs/yojana-core';
import { parsePlan } from './parse.ts';
import { renderPlan } from './render.ts';

export { parsePlan } from './parse.ts';
export { renderPlan } from './render.ts';

/** ParserPort adapter for Markdown plans. The format is described in parse.ts. */
export class MarkdownParser implements ParserPort {
  readonly name = 'markdown';

  parse(source: string, text: string): ParseResult {
    return parsePlan(source, text);
  }

  render(plan: Plan): string {
    return renderPlan(plan);
  }
}
