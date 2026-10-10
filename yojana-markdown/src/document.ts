import {
  type Action,
  actionsRevision,
  assertActionId,
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
const ACTIONS_HEADING = /^###\s+Actions\s*$/i;
const LEVEL3_HEADING = /^###\s/;
const ACTION_ITEM = /^[-*]\s+(?:\[[ xX]\]\s+)?(.*?)(?:\s*\{#([^}]*)\})?\s*$/;
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

interface ActionDraft {
  readonly id: string | undefined;
  text: string;
  readonly attributes: readonly string[];
  readonly line: number;
  readonly claims: Claim[];
}

interface RequirementDraft {
  readonly op: Op | undefined;
  readonly title: string;
  readonly id: string | undefined;
  /** What follows the id inside `{#...}`: `key=value` attributes, e.g. `beads=anv-1,anv-2`. */
  readonly attributes: readonly string[];
  readonly line: number;
  readonly lines: string[];
  readonly claims: Claim[];
  inActions: boolean;
  readonly actions: ActionDraft[];
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
    if (claim === undefined) return;
    if (section.draft.inActions) {
      const lastAction = section.draft.actions[section.draft.actions.length - 1];
      if (lastAction === undefined) {
        issue(
          block.line,
          'CLAIM_WITHOUT_ACTION',
          'a claim under ### Actions must follow an action item',
        );
      } else {
        lastAction.claims.push(claim);
      }
    } else {
      section.draft.claims.push(claim);
    }
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
      const [id, ...attributes] = (requirement[3] ?? '').trim().split(/\s+/);
      sections.push({
        kind: 'requirement',
        draft: {
          op: requirement[1] as Op | undefined,
          title: (requirement[2] ?? '').trim(),
          id: requirement[3] === undefined ? undefined : id,
          attributes,
          line: lineNo,
          lines: [],
          claims: [],
          inActions: false,
          actions: [],
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

    const cur = current();
    if (cur.kind === 'requirement') {
      if (ACTIONS_HEADING.test(line)) {
        cur.draft.inActions = true;
        sawContent = true;
        continue;
      }
      if (cur.draft.inActions) {
        if (LEVEL3_HEADING.test(line)) {
          cur.draft.inActions = false;
        } else if (line.trim() === '') {
          continue;
        } else {
          const actMatch = ACTION_ITEM.exec(line);
          if (actMatch !== null) {
            const [id, ...attributes] = (actMatch[2] ?? '').trim().split(/\s+/);
            cur.draft.actions.push({
              id: actMatch[2] === undefined ? undefined : id,
              text: (actMatch[1] ?? '').trim(),
              attributes: attributes.filter((a) => a !== ''),
              line: lineNo,
              claims: [],
            });
            sawContent = true;
            continue;
          }
          if (cur.draft.actions.length > 0) {
            const lastAct = cur.draft.actions[cur.draft.actions.length - 1];
            if (lastAct !== undefined) {
              lastAct.text = `${lastAct.text} ${line.trim()}`;
            }
            sawContent = true;
            continue;
          }
        }
      }
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
    let workItems: string[] = [];
    let badAttribute = false;
    for (const attribute of draft.attributes) {
      const [key, value = ''] = attribute.split('=', 2);
      if (key === 'beads' && value !== '') {
        workItems = value.split(',').filter((b) => b !== '');
      } else {
        issue(
          draft.line,
          'INVALID_REQUIREMENT_ATTRIBUTE',
          `"${attribute}" is not understood; known: beads=<id>[,<id>...]`,
        );
        badAttribute = true;
      }
    }
    if (badAttribute) continue;

    const seenActions = new Map<string, number>();
    const parsedActions: Action[] = [];
    let badAction = false;
    for (const actDraft of draft.actions) {
      if (actDraft.id === undefined || actDraft.id === '') {
        issue(actDraft.line, 'MISSING_ACTION_ID', 'add an id: - <text> {#act-id}');
        badAction = true;
        continue;
      }
      try {
        assertActionId(actDraft.id);
      } catch (error) {
        issue(actDraft.line, 'INVALID_ACTION_ID', String(error));
        badAction = true;
        continue;
      }
      const firstAct = seenActions.get(actDraft.id);
      if (firstAct !== undefined) {
        issue(
          actDraft.line,
          'DUPLICATE_ACTION_ID',
          `id ${actDraft.id} is already used on line ${firstAct}`,
        );
        badAction = true;
        continue;
      }
      seenActions.set(actDraft.id, actDraft.line);
      let actionWorkItems: string[] = [];
      let badActionAttr = false;
      for (const attr of actDraft.attributes) {
        const [key, value = ''] = attr.split('=', 2);
        if ((key === 'bead' || key === 'beads') && value !== '') {
          actionWorkItems = value.split(',').filter((b) => b !== '');
        } else {
          issue(
            actDraft.line,
            'INVALID_ACTION_ATTRIBUTE',
            `"${attr}" is not understood; known: bead=<id> or beads=<id>[,<id>...]`,
          );
          badActionAttr = true;
        }
      }
      if (badActionAttr) {
        badAction = true;
        continue;
      }
      parsedActions.push({
        id: actDraft.id,
        text: actDraft.text,
        ...(actionWorkItems.length > 0 ? { workItems: actionWorkItems } : {}),
        ...(actDraft.claims.length > 0 ? { claims: actDraft.claims } : {}),
      });
    }
    if (badAction) continue;

    const actions = parsedActions.length > 0 ? parsedActions : undefined;
    const actionsRev = actions !== undefined ? actionsRevision(draft.id, actions) : undefined;
    const fields = {
      id: draft.id,
      title: draft.title,
      text: normalizeContent(draft.lines.join('\n')),
      claims: draft.claims,
      ...(actions !== undefined ? { actions, actionsRevision: actionsRev } : {}),
      ...(workItems.length > 0 ? { workItems } : {}),
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
  return parseClaimRecord(raw, block.line, issue);
}

function parseClaimRecord(raw: unknown, line: number, issue: IssueSink): Claim | undefined {
  if (!isRecord(raw)) {
    issue(line, 'INVALID_CLAIM', 'a claim is a mapping with kind, expression/params and expect');
    return undefined;
  }

  let kind: string | undefined;
  if (typeof raw.kind === 'string' && raw.kind.trim() !== '') {
    kind = raw.kind.trim();
  } else if ('all' in raw) {
    kind = 'all';
  } else if ('any' in raw) {
    kind = 'any';
  } else if ('not' in raw) {
    kind = 'not';
  }

  if (kind === undefined) {
    issue(line, 'INVALID_CLAIM', 'claim needs a non-empty string `kind`');
    return undefined;
  }

  if (kind === 'all' || kind === 'any') {
    let rawChildren = raw.claims;
    if (rawChildren === undefined && kind === 'all') rawChildren = raw.all;
    if (rawChildren === undefined && kind === 'any') rawChildren = raw.any;

    if (!Array.isArray(rawChildren)) {
      issue(
        line,
        'INVALID_CLAIM',
        `"${kind}" claim requires a list of child claims under "claims"`,
      );
      return undefined;
    }
    if (rawChildren.length === 0) {
      issue(line, 'INVALID_CLAIM', `"${kind}" claim requires at least one child claim`);
      return undefined;
    }

    const childClaims: Claim[] = [];
    for (const childRaw of rawChildren) {
      const child = parseClaimRecord(childRaw, line, issue);
      if (child === undefined) return undefined;
      childClaims.push(child);
    }

    const expect = raw.expect ?? true;
    if (typeof expect !== 'boolean' && !isRecord(expect)) {
      issue(line, 'INVALID_CLAIM', '`expect` must be boolean or a predicate mapping');
      return undefined;
    }

    return {
      kind,
      claims: childClaims,
      expect,
    };
  }

  if (kind === 'not') {
    let rawChild: unknown = raw.claim;
    if (rawChild === undefined && 'not' in raw) {
      rawChild = raw.not;
    }
    if (rawChild === undefined && 'claims' in raw) {
      if (Array.isArray(raw.claims)) {
        if (raw.claims.length === 1) {
          rawChild = raw.claims[0];
        } else {
          issue(
            line,
            'INVALID_CLAIM',
            '"not" claim requires a single child claim (use "all" or "any" to combine multiple)',
          );
          return undefined;
        }
      } else {
        rawChild = raw.claims;
      }
    }
    if (Array.isArray(rawChild)) {
      if (rawChild.length === 1) {
        rawChild = rawChild[0];
      } else {
        issue(
          line,
          'INVALID_CLAIM',
          '"not" claim requires a single child claim (use "all" or "any" to combine multiple)',
        );
        return undefined;
      }
    }
    if (!isRecord(rawChild)) {
      issue(line, 'INVALID_CLAIM', '"not" claim requires a child claim');
      return undefined;
    }

    const child = parseClaimRecord(rawChild, line, issue);
    if (child === undefined) return undefined;

    const expect = raw.expect ?? true;
    if (typeof expect !== 'boolean' && !isRecord(expect)) {
      issue(line, 'INVALID_CLAIM', '`expect` must be boolean or a predicate mapping');
      return undefined;
    }

    return {
      kind: 'not',
      claims: [child],
      expect,
    };
  }

  let expression: string | undefined;
  if ('expression' in raw) {
    if (typeof raw.expression !== 'string' || raw.expression.trim() === '') {
      issue(line, 'INVALID_CLAIM', '`expression` must be a non-empty string');
      return undefined;
    }
    expression = raw.expression.trim();
  }

  const params: Record<string, unknown> = {};
  if ('params' in raw) {
    if (isRecord(raw.params)) {
      Object.assign(params, raw.params);
    } else {
      issue(line, 'INVALID_CLAIM', '`params` must be a mapping');
      return undefined;
    }
  }
  for (const [key, val] of Object.entries(raw)) {
    if (key !== 'kind' && key !== 'expression' && key !== 'expect' && key !== 'params') {
      params[key] = val;
    }
  }

  const expect = raw.expect ?? true;
  if (typeof expect !== 'boolean' && !isRecord(expect)) {
    issue(line, 'INVALID_CLAIM', '`expect` must be boolean or a predicate mapping');
    return undefined;
  }

  if (expression === undefined && Object.keys(params).length === 0) {
    issue(line, 'INVALID_CLAIM', 'claim needs an `expression` or parameters');
    return undefined;
  }

  return {
    kind,
    ...(expression !== undefined ? { expression } : {}),
    ...(Object.keys(params).length > 0 ? { params } : {}),
    expect,
  };
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
