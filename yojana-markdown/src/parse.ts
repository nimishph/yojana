import {
  type ParseIssue,
  type ParseResult,
  PLAN_STATUSES,
  type PlanPart,
  type PlanStatus,
  type Requirement,
} from '@cntxt-labs/yojana-core';
import { parseDocument, resolveTitle } from './document.ts';

/**
 * Plan files (docs/design.md#format). Frontmatter: `id` (required), `title`, `status` (default
 * draft), `beads` (list of bead ids). Requirements are plain `## Requirement:` sections; the
 * ADDED/MODIFIED/REMOVED markers belong to change files.
 */
export function parsePlan(source: string, input: string): ParseResult {
  const issues: ParseIssue[] = [];
  const issue = (line: number | undefined, code: string, message: string) =>
    issues.push({ source, line, code, message });

  const doc = parseDocument(input, issue);
  if (doc === undefined) return { ok: false, issues };
  const { meta } = doc;

  const planId = typeof meta.id === 'string' ? meta.id.trim() : '';
  if (planId === '' && doc.metaReadable) {
    issue(2, 'MISSING_PLAN_ID', 'frontmatter needs a non-empty string `id`');
  }

  let status: PlanStatus = 'draft';
  if (meta.status !== undefined) {
    const found = PLAN_STATUSES.find((s) => s === meta.status);
    if (found === undefined) {
      issue(2, 'INVALID_STATUS', `status must be one of ${PLAN_STATUSES.join(', ')}`);
    } else {
      status = found;
    }
  }

  let workItems: string[] = [];
  if (meta.beads !== undefined) {
    if (Array.isArray(meta.beads) && meta.beads.every((b) => typeof b === 'string')) {
      workItems = meta.beads.map((b: string) => b.trim());
    } else {
      issue(2, 'INVALID_BEADS', '`beads` must be a list of bead ids');
    }
  }

  const title = resolveTitle(doc, planId, issue);

  const requirements: Requirement[] = [];
  const parts: PlanPart[] = [];
  for (const part of doc.parts) {
    if (part.kind === 'prose') {
      parts.push(part);
      continue;
    }
    if (part.op !== undefined) {
      issue(
        part.line,
        'CHANGE_MARKER_IN_PLAN',
        `${part.op} belongs in a change file; a plan states requirements as they are`,
      );
      continue;
    }
    requirements.push(part.requirement);
    parts.push({ kind: 'requirement', id: part.requirement.id });
  }

  // Issues are reported in line order whichever stage found them.
  issues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    plan: { id: planId, title, status, workItems, requirements, parts, source },
  };
}
