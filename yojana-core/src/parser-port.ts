import type { ChangeDraft, Plan } from './model.ts';

export interface ParseIssue {
  readonly source: string;
  readonly line?: number | undefined;
  readonly code: string;
  readonly message: string;
}

export type ParseResult =
  | { readonly ok: true; readonly plan: Plan }
  | { readonly ok: false; readonly issues: readonly ParseIssue[] };

export type ChangeParseResult =
  | { readonly ok: true; readonly change: ChangeDraft }
  | { readonly ok: false; readonly issues: readonly ParseIssue[] };

/**
 * Files <-> plans and changes. Markdown is the editing format; OpenSpec import/export and the HTML
 * review renderer are further adapters.
 */
export interface ParserPort {
  readonly name: string;
  parse(source: string, text: string): ParseResult;
  parseChange(source: string, text: string): ChangeParseResult;
  render(plan: Plan): string;
}
