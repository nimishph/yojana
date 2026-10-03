import {
  assertChangeId,
  type ChangeParseResult,
  type DeltaDraft,
  type ParseIssue,
} from '@cntxt-labs/yojana-core';
import { parseDocument, resolveTitle } from './document.ts';

/**
 * Change files: a proposed edit to one plan.
 *
 *   ---
 *   id: plugin-npx-fallback        change id (kebab-case)
 *   plan: plan/plugin-packaging    the plan it changes
 *   title: Prefer a global anvesa  optional
 *   ---
 *   Why this change. (prose, kept with the change file, not applied to the plan)
 *
 *   ## MODIFIED Requirement: <title> {#id}     the requirement as it should read afterwards
 *   ## ADDED Requirement: <title> {#id}        a new requirement
 *   ## REMOVED Requirement: <title> {#id}      body, if any, is the reason and is not applied
 *
 * Every requirement section needs one of the three markers.
 */
export function parseChange(source: string, input: string): ChangeParseResult {
  const issues: ParseIssue[] = [];
  const issue = (line: number | undefined, code: string, message: string) =>
    issues.push({ source, line, code, message });

  const doc = parseDocument(input, issue);
  if (doc === undefined) return { ok: false, issues };
  const { meta } = doc;

  const id = typeof meta.id === 'string' ? meta.id.trim() : '';
  if (doc.metaReadable) {
    if (id === '') issue(2, 'MISSING_CHANGE_ID', 'frontmatter needs a non-empty string `id`');
    else {
      try {
        assertChangeId(id);
      } catch (error) {
        issue(2, 'INVALID_CHANGE_ID', String(error));
      }
    }
  }
  const planId = typeof meta.plan === 'string' ? meta.plan.trim() : '';
  if (planId === '' && doc.metaReadable) {
    issue(2, 'MISSING_PLAN', 'frontmatter needs `plan`: the id of the plan this change edits');
  }
  const title = resolveTitle(doc, id, issue);

  const deltas: DeltaDraft[] = [];
  for (const part of doc.parts) {
    if (part.kind === 'prose') continue;
    const { op, requirement, line } = part;
    if (op === 'ADDED') deltas.push({ op: 'add', requirement });
    else if (op === 'MODIFIED') deltas.push({ op: 'modify', requirement });
    else if (op === 'REMOVED') deltas.push({ op: 'remove', id: requirement.id });
    else {
      issue(
        line,
        'MISSING_CHANGE_MARKER',
        'say what this does: ## ADDED, ## MODIFIED or ## REMOVED Requirement: ...',
      );
    }
  }
  if (deltas.length === 0 && issues.length === 0) {
    issue(
      undefined,
      'EMPTY_CHANGE',
      'a change needs at least one ADDED, MODIFIED or REMOVED requirement',
    );
  }

  issues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, change: { id, planId, title, deltas, source } };
}
