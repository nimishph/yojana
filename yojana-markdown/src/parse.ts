import {
  assertRequirementId,
  type Claim,
  normalizeContent,
  type ParseIssue,
  type ParseResult,
  PLAN_STATUSES,
  type PlanPart,
  type PlanStatus,
  type Requirement,
  requirementRevision,
} from '@cntxt-labs/yojana-core';

/**
 * Markdown plan format (docs/design.md#format):
 *
 *   ---                                   YAML frontmatter: id (required), title, status, beads
 *   # Title                               optional; the frontmatter title wins and must agree
 *   prose ...                             kept verbatim, in order
 *   ## Requirement: <title> {#<id>}       a requirement runs to the next level-2 heading
 *   ```yojana:claim                       claims inside a requirement: kind, expression, expect
 *   ```
 *   ## Any other heading                  prose again
 *
 * Headings inside code fences are text. Problems are reported as issues with line numbers; the
 * parser never throws on bad input and never drops content silently.
 */

const REQUIREMENT_HEADING = /^##\s+Requirement:\s*(.*?)\s*(?:\{#([^}]*)\})?\s*$/;
const LEVEL2_HEADING = /^##\s/;
const TITLE_HEADING = /^#\s+(.*?)\s*#*\s*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const FRONTMATTER_FENCE = '---';

interface Fence {
  readonly marker: string;
  readonly info: string;
  /** 1-based line of the opening fence. */
  readonly line: number;
  readonly body: string[];
}

interface RequirementDraft {
  readonly title: string;
  readonly id: string | undefined;
  readonly line: number;
  readonly lines: string[];
  readonly claims: Claim[];
}

type Section =
  | { readonly kind: 'prose'; readonly lines: string[] }
  | { readonly kind: 'requirement'; readonly draft: RequirementDraft };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function closesFence(line: string, fence: Fence): boolean {
  const trimmed = line.trim();
  const char = fence.marker.charAt(0);
  return (
    trimmed.length >= fence.marker.length &&
    [...trimmed].every((c) => c === char) &&
    line.length - line.trimStart().length <= 3
  );
}

function trimBlankLines(lines: readonly string[]): string {
  return lines
    .join('\n')
    .replace(/^\s*\n/, '')
    .trimEnd();
}

export function parsePlan(source: string, input: string): ParseResult {
  const issues: ParseIssue[] = [];
  const issue = (line: number | undefined, code: string, message: string) =>
    issues.push({ source, line, code, message });

  const lines = input.replace(/\r\n?/g, '\n').split('\n');

  // Frontmatter.
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) {
    issue(1, 'MISSING_FRONTMATTER', 'a plan starts with YAML frontmatter between --- lines');
    return { ok: false, issues };
  }
  const closing = lines.findIndex((l, i) => i > 0 && l.trim() === FRONTMATTER_FENCE);
  if (closing === -1) {
    issue(1, 'MISSING_FRONTMATTER', 'the frontmatter opened on line 1 is never closed with ---');
    return { ok: false, issues };
  }
  // When the frontmatter itself is unreadable, field checks would only repeat that one problem.
  let meta: Record<string, unknown> = {};
  let metaReadable = true;
  try {
    const parsed: unknown = Bun.YAML.parse(lines.slice(1, closing).join('\n'));
    if (parsed !== null && parsed !== undefined && !isRecord(parsed)) {
      issue(2, 'INVALID_FRONTMATTER', 'frontmatter must be a mapping of keys to values');
      metaReadable = false;
    } else if (isRecord(parsed)) {
      meta = parsed;
    }
  } catch (error) {
    issue(2, 'INVALID_FRONTMATTER', `frontmatter is not valid YAML: ${String(error)}`);
    metaReadable = false;
  }

  const planId = typeof meta.id === 'string' ? meta.id.trim() : '';
  if (planId === '' && metaReadable) {
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

  let title = typeof meta.title === 'string' ? meta.title.trim() : '';

  // Body.
  const sections: Section[] = [{ kind: 'prose', lines: [] }];
  let fence: Fence | undefined;
  let sawContent = false;

  const current = (): Section => sections[sections.length - 1] ?? { kind: 'prose', lines: [] };
  const pushLine = (line: string) => {
    const section = current();
    if (section.kind === 'prose') section.lines.push(line);
    else section.draft.lines.push(line);
  };

  const finishYojanaBlock = (block: Fence) => {
    const section = current();
    if (block.info !== 'yojana:claim') {
      issue(block.line, 'UNKNOWN_BLOCK', `unknown block \`${block.info}\`; known: yojana:claim`);
      return;
    }
    if (section.kind !== 'requirement') {
      issue(block.line, 'CLAIM_OUTSIDE_REQUIREMENT', 'a claim must sit inside a requirement');
      return;
    }
    const claim = parseClaim(block, issue);
    if (claim !== undefined) section.draft.claims.push(claim);
  };

  for (let i = closing + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;

    if (fence !== undefined) {
      if (closesFence(line, fence)) {
        if (fence.info.startsWith('yojana:')) finishYojanaBlock(fence);
        else pushLine(line);
        fence = undefined;
      } else if (fence.info.startsWith('yojana:')) {
        fence.body.push(line);
      } else {
        pushLine(line);
      }
      continue;
    }

    const open = FENCE_OPEN.exec(line);
    if (open !== null) {
      fence = { marker: open[1] ?? '```', info: open[2] ?? '', line: lineNo, body: [] };
      if (!fence.info.startsWith('yojana:')) pushLine(line);
      sawContent = true;
      continue;
    }

    const titleMatch = TITLE_HEADING.exec(line);
    if (titleMatch !== null && !sawContent) {
      const heading = (titleMatch[1] ?? '').trim();
      if (title === '') title = heading;
      else if (heading !== title) {
        issue(lineNo, 'TITLE_MISMATCH', `heading "${heading}" differs from frontmatter title`);
      }
      sawContent = true;
      continue;
    }

    const requirement = REQUIREMENT_HEADING.exec(line);
    if (requirement !== null) {
      sections.push({
        kind: 'requirement',
        draft: {
          title: (requirement[1] ?? '').trim(),
          id: requirement[2]?.trim(),
          line: lineNo,
          lines: [],
          claims: [],
        },
      });
      sawContent = true;
      continue;
    }

    if (LEVEL2_HEADING.test(line)) {
      sections.push({ kind: 'prose', lines: [line] });
      sawContent = true;
      continue;
    }

    if (line.trim() !== '') sawContent = true;
    pushLine(line);
  }

  if (fence !== undefined) {
    issue(fence.line, 'UNCLOSED_FENCE', `code fence ${fence.marker} is never closed`);
  }

  if (title === '') title = planId;

  const requirements: Requirement[] = [];
  const parts: PlanPart[] = [];
  const seen = new Map<string, number>();

  for (const section of sections) {
    if (section.kind === 'prose') {
      const markdown = trimBlankLines(section.lines);
      if (markdown !== '') parts.push({ kind: 'prose', markdown });
      continue;
    }
    const { draft } = section;
    if (draft.id === undefined || draft.id === '') {
      issue(draft.line, 'MISSING_REQUIREMENT_ID', 'add an id: ## Requirement: <title> {#req-id}');
      continue;
    }
    try {
      assertRequirementId(draft.id);
    } catch (error) {
      issue(draft.line, 'INVALID_REQUIREMENT_ID', String(error));
      continue;
    }
    const first = seen.get(draft.id);
    if (first !== undefined) {
      issue(
        draft.line,
        'DUPLICATE_REQUIREMENT_ID',
        `id ${draft.id} is already used on line ${first}`,
      );
      continue;
    }
    seen.set(draft.id, draft.line);
    const fields = {
      id: draft.id,
      title: draft.title,
      text: normalizeContent(draft.lines.join('\n')),
      claims: draft.claims,
    };
    requirements.push({ ...fields, revision: requirementRevision(fields) });
    parts.push({ kind: 'requirement', id: draft.id });
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    plan: { id: planId, title, status, workItems, requirements, parts, source },
  };
}

function parseClaim(
  block: Fence,
  issue: (line: number, code: string, message: string) => void,
): Claim | undefined {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(block.body.join('\n'));
  } catch (error) {
    issue(block.line, 'INVALID_CLAIM', `claim is not valid YAML: ${String(error)}`);
    return undefined;
  }
  if (!isRecord(raw)) {
    issue(block.line, 'INVALID_CLAIM', 'a claim is a mapping with kind, expression and expect');
    return undefined;
  }
  const { kind, expression } = raw;
  const expect = raw.expect ?? true;
  if (typeof kind !== 'string' || kind.trim() === '') {
    issue(block.line, 'INVALID_CLAIM', 'claim needs a non-empty string `kind`');
    return undefined;
  }
  if (typeof expression !== 'string' || expression.trim() === '') {
    issue(block.line, 'INVALID_CLAIM', 'claim needs a non-empty string `expression`');
    return undefined;
  }
  if (typeof expect !== 'boolean') {
    issue(block.line, 'INVALID_CLAIM', '`expect` must be true or false');
    return undefined;
  }
  return { kind: kind.trim(), expression: expression.trim(), expect };
}
