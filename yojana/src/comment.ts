import { randomUUID } from 'node:crypto';
import { type Annotation, foldLog, type StorePort } from '@cntxt-labs/yojana-core';

/**
 * Comment: a review note on one requirement, recorded in the log against the requirement's
 * current revision. When the requirement later changes, the note shows as outdated rather than
 * disappearing or silently attaching to text it was not about.
 */

export type CommentResult =
  | { readonly ok: true; readonly annotation: Annotation }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Characters of a random UUID used for a comment id: short to type, ample for one plan. */
const COMMENT_ID_CHARS = 8;

export async function comment(options: {
  readonly store: StorePort;
  readonly planId: string;
  readonly requirement: string;
  readonly body: string;
  readonly author: string;
  readonly quote?: string | undefined;
  readonly replyTo?: string | undefined;
}): Promise<CommentResult> {
  const fail = (code: string, message: string): CommentResult => ({ ok: false, code, message });
  const body = options.body.trim();
  if (body === '') return fail('EMPTY_COMMENT', 'a comment needs some text');

  const plan = foldLog(await options.store.events()).plans.get(options.planId);
  if (plan === undefined) return fail('PLAN_NOT_FOUND', `the log has no plan ${options.planId}`);
  const head = plan.heads.get(options.requirement);
  if (head === undefined) {
    return fail('NOT_FOUND', `${options.requirement} is not a requirement of ${options.planId}`);
  }
  const quote = options.quote?.trim();
  if (quote !== undefined && quote !== '' && !quoteAppears(head.text, quote)) {
    return fail('QUOTE_NOT_FOUND', `"${quote}" does not appear in ${options.requirement}`);
  }
  if (options.replyTo !== undefined && !plan.annotations.some((a) => a.id === options.replyTo)) {
    return fail('COMMENT_NOT_FOUND', `no comment ${options.replyTo} on ${options.planId}`);
  }

  const annotation: Annotation = {
    id: `n_${randomUUID().replaceAll('-', '').slice(0, COMMENT_ID_CHARS)}`,
    requirement: head.id,
    revision: head.revision,
    author: options.author,
    body,
    quote: quote === '' ? undefined : quote,
    replyTo: options.replyTo,
  };
  await options.store.append(
    { type: 'annotation-added', planId: options.planId, annotation },
    options.author,
  );
  return { ok: true, annotation };
}

/**
 * Text as a reader sees it: Markdown marks (backticks, emphasis) and line breaks do not count. A
 * quote selected on the rendered page has lost them, so it is compared in this form.
 */
function asRead(text: string): string {
  return text.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
}

/** Whether a quote appears in a requirement, as written or as the page renders it. */
export function quoteAppears(text: string, quote: string): boolean {
  return text.includes(quote) || asRead(text).includes(asRead(quote));
}
