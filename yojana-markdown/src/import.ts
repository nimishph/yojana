import { normalizeContent } from '@cntxt-labs/yojana-core';
import { parsePlan } from './parse.ts';

/**
 * Import: start a plan from a Markdown roadmap that was not written for yojana.
 *
 *   - The H1 becomes the title.
 *   - Requirements: if headings name bead ids (`anv-1mh`), the heading level where they appear is
 *     the requirement level, and each such heading's bead ids become its `beads=` link. Without
 *     bead ids, every `##` section is a requirement.
 *   - Headings above the requirement level, and text before the first requirement, stay as prose.
 *   - Tables with a Status column are dropped: progress comes from beads, and a hand-typed status
 *     goes stale (the one in anvesa's roadmap already had).
 *   - Every bead id found anywhere goes into the frontmatter `beads:` list.
 *
 * The result is parsed before it is returned, so what import hands back is a valid plan. It is a
 * starting point to review, not a finished plan: claims still have to be written by a person.
 */

export interface ImportOptions {
  readonly source: string;
  readonly planId: string;
  /** Bead id prefix (`anv`); detected from the document when not given. */
  readonly prefix?: string | undefined;
  readonly status?: string | undefined;
}

export interface ImportReport {
  readonly markdown: string;
  readonly title: string;
  readonly requirements: readonly { readonly id: string; readonly beads: readonly string[] }[];
  readonly beads: readonly string[];
  /** How the bead prefix was chosen, for the person to confirm. */
  readonly prefix: { readonly value: string; readonly detected: boolean } | undefined;
  readonly droppedTables: number;
  readonly level: number;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const BACKTICKED = /`([a-z][a-z0-9]*)-([a-z0-9]{3,4}(?:\.\d+)*)`/g;
const MAX_ID = 64;
/** Words of the title kept in a generated requirement id. */
const ID_WORDS = 5;
/** Markdown has six heading levels; a deeper nesting is written at the sixth. */
const MARKDOWN_DEEPEST_HEADING = 6;

interface Line {
  readonly text: string;
  readonly inFence: boolean;
}

function markFences(text: string): Line[] {
  let fence: string | undefined;
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const open = FENCE.exec(line);
      const wasIn = fence !== undefined;
      if (open !== null) {
        const marker = open[1] ?? '';
        if (fence === undefined) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        return { text: line, inFence: true };
      }
      return { text: line, inFence: wasIn };
    });
}

/** The most common prefix among backticked bd-shaped ids, if any. */
function detectPrefix(text: string): string | undefined {
  const counts = new Map<string, Set<string>>();
  for (const match of text.matchAll(BACKTICKED)) {
    const prefix = match[1] ?? '';
    const ids = counts.get(prefix) ?? new Set<string>();
    ids.add(match[0]);
    counts.set(prefix, ids);
  }
  const ranked = [...counts].sort((a, b) => b[1].size - a[1].size);
  const best = ranked[0];
  return best !== undefined && best[1].size >= 2 ? best[0] : undefined;
}

function beadsIn(text: string, prefix: string | undefined): string[] {
  if (prefix === undefined) return [];
  const pattern = new RegExp(`\\b${prefix}-[a-z0-9]{3,4}(?:\\.\\d+)*\\b`, 'g');
  return [...new Set(text.match(pattern) ?? [])];
}

/**
 * `req-` and the title's first few words: enough to recognise, short enough to type in a change
 * file. A collision gets `-2`, `-3`, ... from the caller.
 */
function slug(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/`/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
  const id = ['req', ...words.slice(0, ID_WORDS)].join('-').slice(0, MAX_ID).replace(/-+$/, '');
  return id === 'req' ? 'req-untitled' : id;
}

function isStatusTable(block: readonly string[]): boolean {
  const header = block[0] ?? '';
  return /\|\s*status\s*\|/i.test(header);
}

export function importRoadmap(text: string, options: ImportOptions): ImportReport {
  const lines = markFences(text);
  const prefix = options.prefix ?? detectPrefix(text);
  const headings = lines
    .map((line, index) => ({ line, index, match: line.inFence ? null : HEADING.exec(line.text) }))
    .filter((h) => h.match !== null)
    .map((h) => ({
      index: h.index,
      level: (h.match?.[1] ?? '').length,
      title: (h.match?.[2] ?? '').trim(),
    }));

  const h1 = headings.find((h) => h.level === 1);
  const title = h1?.title.replace(/`/g, '') ?? options.planId;

  // Requirement level: where bead ids sit in headings; otherwise ##.
  const levelCounts = new Map<number, number>();
  for (const h of headings) {
    if (h.level > 1 && beadsIn(h.title, prefix).length > 0) {
      levelCounts.set(h.level, (levelCounts.get(h.level) ?? 0) + 1);
    }
  }
  const level = [...levelCounts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 2;

  const out: string[] = [];
  const requirements: { id: string; beads: string[] }[] = [];
  const usedIds = new Set<string>();
  let droppedTables = 0;
  let table: string[] = [];

  const flushTable = () => {
    if (table.length === 0) return;
    if (isStatusTable(table)) {
      droppedTables++;
      out.push('_(A status table was here; progress now comes from the beads.)_');
    } else {
      out.push(...table);
    }
    table = [];
  };

  for (const [index, line] of lines.entries()) {
    if (!line.inFence && line.text.trimStart().startsWith('|')) {
      table.push(line.text);
      continue;
    }
    flushTable();
    if (h1 !== undefined && index === h1.index) continue;
    const heading = headings.find((h) => h.index === index);
    if (heading === undefined) {
      out.push(line.text);
      continue;
    }
    if (heading.level === level) {
      const beads = beadsIn(heading.title, prefix);
      // "anv-1mh: Support $schema" -> "Support $schema"; the id moves to beads=.
      const leadingIds = beads.map((b) => b.replaceAll('.', '\\.')).join('|');
      const cleanTitle =
        heading.title
          .replace(/`/g, '')
          .replace(new RegExp(`^(?:${leadingIds})\\s*[:\\-–—]\\s*`), '')
          .trim() || heading.title;
      let id = slug(cleanTitle);
      for (let n = 2; usedIds.has(id); n++) id = `${slug(cleanTitle)}-${n}`;
      usedIds.add(id);
      requirements.push({ id, beads });
      const links = beads.length > 0 ? ` beads=${beads.join(',')}` : '';
      out.push(`## Requirement: ${cleanTitle} {#${id}${links}}`);
    } else if (heading.level < level) {
      out.push(`## ${heading.title}`);
    } else {
      // Deeper than requirements: kept inside the section, one level below it is ###.
      const depth = Math.max(3, heading.level - level + 2);
      out.push(`${'#'.repeat(Math.min(depth, MARKDOWN_DEEPEST_HEADING))} ${heading.title}`);
    }
  }
  flushTable();

  const beads = beadsIn(text, prefix);
  const status = options.status ?? 'draft';
  const frontmatter = [
    '---',
    `id: ${options.planId}`,
    `title: ${JSON.stringify(title)}`,
    `status: ${status}`,
    `beads: [${beads.join(', ')}]`,
    '---',
    '',
    `# ${title}`,
    '',
    `_Imported from ${options.source}. Add claims to make the requirements checkable._`,
    '',
  ];
  const markdown = `${normalizeContent([...frontmatter, ...out].join('\n'))}\n`;
  return {
    markdown,
    title,
    requirements,
    beads,
    prefix:
      prefix === undefined ? undefined : { value: prefix, detected: options.prefix === undefined },
    droppedTables,
    level,
  };
}

/** Import and confirm the result parses as a plan; the parse issues are returned when it does not. */
export function importAndValidate(text: string, options: ImportOptions) {
  const report = importRoadmap(text, options);
  const parsed = parsePlan(options.source, report.markdown);
  return { report, issues: parsed.ok ? [] : parsed.issues };
}
