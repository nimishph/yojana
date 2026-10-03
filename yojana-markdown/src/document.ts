import {
  assertRequirementId,
  type Claim,
  normalizeContent,
  type Requirement,
  requirementRevision,
} from '@cntxt-labs/yojana-core';

/**
 * The Markdown shape shared by plan files and change files:
 *
 *   ---                                        YAML frontmatter
 *   # Title                                    optional
 *   prose ...                                  kept verbatim, in order
 *   ## [ADDED|MODIFIED|REMOVED ]Requirement: <title> {#<id>}
 *   ```yojana:claim                            claims inside a requirement
 *   ```
 *   ## Any other heading                       prose again
 *
 * A requirement runs to the next level-2 heading. Headings inside code fences are text. Problems
 * are collected as issues with line numbers; nothing here throws on bad input or drops content.
 * Plans and changes decide which ops they allow (parse.ts, change.ts).
 */

export type Op = 'ADDED' | 'MODIFIED' | 'REMOVED';

const REQUIREMENT_HEADING =
  /^##\s+(?:(ADDED|MODIFIED|REMOVED)\s+)?Requirement:\s*(.*?)\s*(?:\{#([^}]*)\})?\s*$/;
const LEVEL2_HEADING = /^##\s/;
const TITLE_HEADING = /^#\s+(.*?)\s*#*\s*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const FRONTMATTER_FENCE = '---';
/** git's conflict markers; inside a code fence they are example text and left alone. */
const GIT_CONFLICT_MARKER = /^(<{7} |={7}$|>{7} )/;

export type DocumentPart =
  | { readonly kind: 'prose'; readonly markdown: string }
  | {
      readonly kind: 'requirement';
      readonly op: Op | undefined;
      readonly line: number;
      readonly requirement: Requirement;
    };

export interface ParsedDocument {
  readonly meta: Record<string, unknown>;
  /** False when the frontmatter could not be read; field checks would only repeat that issue. */
  readonly metaReadable: boolean;
  /** The H1, when the document has one. */
  readonly heading: string | undefined;
  readonly headingLine: number | undefined;
  readonly parts: readonly DocumentPart[];
}

export type IssueSink = (line: number | undefined, code: string, message: string) => void;

interface Fence {
  readonly marker: string;
  readonly info: string;
  readonly line: number;
  readonly body: string[];
}

interface RequirementDraft {
  readonly op: Op | undefined;
  readonly title: string;
  readonly id: string | undefined;
  readonly line: number;
  readonly lines: string[];
  readonly claims: Claim[];
}

type Section =
  | { readonly kind: 'prose'; readonly lines: string[] }
  | { readonly kind: 'requirement'; readonly draft: RequirementDraft };

export function isRecord(value: unknown): value is Record<string, unknown> {
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

/** Returns undefined when there is no usable frontmatter (already reported). */
export function parseDocument(input: string, issue: IssueSink): ParsedDocument | undefined {
  const lines = input.replace(/\r\n?/g, '\n').split('\n');

  if (lines[0]?.trim() !== FRONTMATTER_FENCE) {
    issue(1, 'MISSING_FRONTMATTER', 'the file starts with YAML frontmatter between --- lines');
    return undefined;
  }
  const closing = lines.findIndex((l, i) => i > 0 && l.trim() === FRONTMATTER_FENCE);
  if (closing === -1) {
    issue(1, 'MISSING_FRONTMATTER', 'the frontmatter opened on line 1 is never closed with ---');
    return undefined;
  }

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

  const sections: Section[] = [{ kind: 'prose', lines: [] }];
  let fence: Fence | undefined;
  let sawContent = false;
  let heading: string | undefined;
  let headingLine: number | undefined;

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

    if (GIT_CONFLICT_MARKER.test(line)) {
      issue(
        lineNo,
        'GIT_CONFLICT_MARKER',
        'this file still has a git merge conflict; resolve it before yojana reads it',
      );
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
      heading = (titleMatch[1] ?? '').trim();
      headingLine = lineNo;
      sawContent = true;
      continue;
    }

    const requirement = REQUIREMENT_HEADING.exec(line);
    if (requirement !== null) {
      sections.push({
        kind: 'requirement',
        draft: {
          op: requirement[1] as Op | undefined,
          title: (requirement[2] ?? '').trim(),
          id: requirement[3]?.trim(),
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

  const parts: DocumentPart[] = [];
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
    parts.push({
      kind: 'requirement',
      op: draft.op,
      line: draft.line,
      requirement: { ...fields, revision: requirementRevision(fields) },
    });
  }

  return { meta, metaReadable, heading, headingLine, parts };
}

function parseClaim(block: Fence, issue: IssueSink): Claim | undefined {
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

/** Title rule shared by plans and changes: frontmatter wins, and an H1 must agree with it. */
export function resolveTitle(doc: ParsedDocument, fallback: string, issue: IssueSink): string {
  const fromMeta = typeof doc.meta.title === 'string' ? doc.meta.title.trim() : '';
  if (fromMeta !== '' && doc.heading !== undefined && doc.heading !== fromMeta) {
    issue(
      doc.headingLine,
      'TITLE_MISMATCH',
      `heading "${doc.heading}" differs from frontmatter title`,
    );
  }
  return fromMeta !== '' ? fromMeta : (doc.heading ?? fallback);
}
