import type { ChangeParseResult, ParseResult, ParserPort, Plan } from '@cntxt-labs/yojana-core';
import { parseChange } from './change.ts';
import { parsePlan } from './parse.ts';
import { renderPlan } from './render.ts';

export { parseChange } from './change.ts';
export { parsePlan } from './parse.ts';
export { renderPlan } from './render.ts';

/** ParserPort adapter for Markdown plans and changes. The format is described in document.ts. */
export class MarkdownParser implements ParserPort {
  readonly name = 'markdown';

  parse(source: string, text: string): ParseResult {
    return parsePlan(source, text);
  }

  parseChange(source: string, text: string): ChangeParseResult {
    return parseChange(source, text);
  }

  render(plan: Plan): string {
    return renderPlan(plan);
  }
}
export {
  type ImportOptions,
  type ImportReport,
  importAndValidate,
  importRoadmap,
} from './import.ts';
