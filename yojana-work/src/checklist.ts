import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  WorkChange,
  WorkCreateResult,
  WorkItem,
  WorkLinkPort,
  WorkLookup,
} from '@cntxt-labs/yojana-core';

export interface ChecklistWorkLinkOptions {
  /** Directory containing plan markdown files (e.g. 'plans' or '.'). */
  readonly plansDir?: string | undefined;
  /** Explicit plan file paths to read. */
  readonly files?: readonly string[] | undefined;
  /** Optional file reader (defaults to reading from filesystem). */
  readonly readFile?: ((path: string) => Promise<string> | string) | undefined;
  /** Optional file writer (defaults to writing to filesystem). */
  readonly writeFile?: ((path: string, content: string) => Promise<void> | void) | undefined;
  /** Optional file lister (defaults to listing .md files from plansDir). */
  readonly listFiles?: (() => Promise<readonly string[]> | readonly string[]) | undefined;
}

interface ParsedChecklistItem {
  readonly id: string;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly rawState: string;
  readonly filePath: string;
  readonly lineIndex: number;
  readonly reqId: string;
  readonly hasExplicitCheckbox: boolean;
}

interface ParsedRequirement {
  readonly id: string;
  readonly title: string;
  readonly filePath: string;
  readonly lineIndex: number;
  readonly items: ParsedChecklistItem[];
  readonly actionsHeadingLineIndex?: number | undefined;
  readonly endLineIndex: number;
}

const REQUIREMENT_HEADING =
  /^##\s+(?:(ADDED|MODIFIED|REMOVED)\s+)?(?:Requirement:\s*)?(.*?)\s*(?:\{#([^}]*)\})?\s*$/i;
const ACTIONS_HEADING = /^###\s+Actions\s*$/i;
const CHECKLIST_OR_ACTION_ITEM = /^([-*])\s+(?:\[([ xX])\]\s+)?(.*?)(?:\s*\{#([^}]*)\})?\s*$/;
const NEXT_HEADING = /^##\s/;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Plain-Markdown checklist adapter with no external tool.
 * Items with `- [x]` under a requirement count as done (closed); items with `- [ ]` or unchecked count as open.
 * Supports close/reopen by toggling `- [x]` / `- [ ]` in the markdown files, and create by appending checklist items.
 */
export class ChecklistWorkLink implements WorkLinkPort {
  readonly name = 'checklist';
  readonly #options: ChecklistWorkLinkOptions;

  constructor(options: ChecklistWorkLinkOptions = {}) {
    this.#options = options;
  }

  async get(ids: readonly string[]): Promise<WorkLookup> {
    if (ids.length === 0) return { ok: true, items: [] };

    let state: {
      requirements: Map<string, ParsedRequirement>;
      items: Map<string, ParsedChecklistItem>;
    };
    try {
      state = await this.#load();
    } catch (error) {
      return { ok: false, error: `could not read checklist markdown files: ${String(error)}` };
    }

    const result: WorkItem[] = [];

    for (const id of ids) {
      // 1. Match as a checklist/action item
      const item = state.items.get(id);
      if (item !== undefined) {
        result.push({
          id,
          title: item.title,
          state: item.state,
          rawState: item.rawState,
        });
        continue;
      }

      // 2. Match as a requirement (an epic composed of its checklist items)
      const req = state.requirements.get(id);
      if (req !== undefined) {
        let reqState: 'open' | 'in-progress' | 'closed' = 'open';
        let rawState = 'open';

        if (req.items.length > 0) {
          const closedCount = req.items.filter((i) => i.state === 'closed').length;
          if (closedCount === req.items.length) {
            reqState = 'closed';
            rawState = 'all-done';
          } else if (closedCount > 0) {
            reqState = 'in-progress';
            rawState = `${closedCount}/${req.items.length} done`;
          } else {
            reqState = 'open';
            rawState = `0/${req.items.length} done`;
          }
        }

        result.push({
          id,
          title: req.title,
          state: reqState,
          rawState,
        });
        continue;
      }

      // 3. Not found
      result.push({ id, title: '', state: 'missing' });
    }

    return { ok: true, items: result };
  }

  async children(id: string): Promise<WorkLookup> {
    let state: {
      requirements: Map<string, ParsedRequirement>;
      items: Map<string, ParsedChecklistItem>;
    };
    try {
      state = await this.#load();
    } catch (error) {
      return { ok: false, error: `could not read checklist markdown files: ${String(error)}` };
    }

    const req = state.requirements.get(id);
    if (req !== undefined) {
      return {
        ok: true,
        items: req.items.map((i) => ({
          id: i.id,
          title: i.title,
          state: i.state,
          rawState: i.rawState,
        })),
      };
    }

    return { ok: true, items: [] };
  }

  async close(id: string, _reason: string): Promise<WorkChange> {
    return this.#toggle(id, true);
  }

  async reopen(id: string, _reason: string): Promise<WorkChange> {
    return this.#toggle(id, false);
  }

  async create(options: {
    readonly title: string;
    readonly parent?: string | undefined;
    readonly description?: string | undefined;
  }): Promise<WorkCreateResult> {
    let state: {
      requirements: Map<string, ParsedRequirement>;
      items: Map<string, ParsedChecklistItem>;
    };
    try {
      state = await this.#load();
    } catch (error) {
      return { ok: false, error: `could not read checklist markdown files: ${String(error)}` };
    }

    let targetReq: ParsedRequirement | undefined;
    if (options.parent !== undefined) {
      targetReq = state.requirements.get(options.parent);
      if (targetReq === undefined) {
        return { ok: false, error: `checklist has no requirement parent ${options.parent}` };
      }
    } else {
      // Pick first requirement found
      const first = state.requirements.values().next().value;
      if (first === undefined) {
        return { ok: false, error: 'no requirements found in checklist plan files' };
      }
      targetReq = first;
    }

    const content = await this.#read(targetReq.filePath);
    const lines = content.split('\n');

    const newId = `act-${slugify(options.title) || Date.now().toString(36)}`;
    const lineToInsert = `- [ ] ${options.title} {#${newId}}`;

    let insertIndex = targetReq.endLineIndex;
    if (targetReq.items.length > 0) {
      const lastItem = targetReq.items[targetReq.items.length - 1];
      if (lastItem) insertIndex = lastItem.lineIndex + 1;
    } else if (targetReq.actionsHeadingLineIndex !== undefined) {
      insertIndex = targetReq.actionsHeadingLineIndex + 1;
    }

    lines.splice(insertIndex, 0, lineToInsert);
    await this.#write(targetReq.filePath, lines.join('\n'));

    return { ok: true, id: newId };
  }

  async #toggle(id: string, done: boolean): Promise<WorkChange> {
    let state: {
      requirements: Map<string, ParsedRequirement>;
      items: Map<string, ParsedChecklistItem>;
    };
    try {
      state = await this.#load();
    } catch (error) {
      return { ok: false, error: `could not read checklist markdown files: ${String(error)}` };
    }

    // 1. Is it a checklist item?
    const item = state.items.get(id);
    if (item !== undefined) {
      const content = await this.#read(item.filePath);
      const lines = content.split('\n');
      const originalLine = lines[item.lineIndex] ?? '';

      let updatedLine: string;
      if (item.hasExplicitCheckbox) {
        updatedLine = originalLine.replace(/\[[ xX]\]/, done ? '[x]' : '[ ]');
      } else {
        // Was `- Text {#id}`, add checkbox: `- [x] Text {#id}`
        updatedLine = originalLine.replace(/^([-*]\s+)/, `$1${done ? '[x]' : '[ ]'} `);
      }

      lines[item.lineIndex] = updatedLine;
      await this.#write(item.filePath, lines.join('\n'));
      return { ok: true };
    }

    // 2. Is it a requirement? Toggle all items under it
    const req = state.requirements.get(id);
    if (req !== undefined) {
      if (req.items.length === 0) return { ok: true };

      const content = await this.#read(req.filePath);
      const lines = content.split('\n');

      for (const reqItem of req.items) {
        const line = lines[reqItem.lineIndex] ?? '';
        let updatedLine: string;
        if (reqItem.hasExplicitCheckbox) {
          updatedLine = line.replace(/\[[ xX]\]/, done ? '[x]' : '[ ]');
        } else {
          updatedLine = line.replace(/^([-*]\s+)/, `$1${done ? '[x]' : '[ ]'} `);
        }
        lines[reqItem.lineIndex] = updatedLine;
      }

      await this.#write(req.filePath, lines.join('\n'));
      return { ok: true };
    }

    return { ok: false, error: `checklist has no item ${id}` };
  }

  async #load(): Promise<{
    requirements: Map<string, ParsedRequirement>;
    items: Map<string, ParsedChecklistItem>;
  }> {
    const filePaths = await this.#discoverFiles();
    const requirements = new Map<string, ParsedRequirement>();
    const items = new Map<string, ParsedChecklistItem>();

    for (const filePath of filePaths) {
      const content = await this.#read(filePath);
      const lines = content.split('\n');

      let currentReq: ParsedRequirement | undefined;
      let actionsHeadingIndex: number | undefined;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';

        const reqMatch = REQUIREMENT_HEADING.exec(line);
        if (reqMatch !== null) {
          if (currentReq !== undefined) {
            requirements.set(currentReq.id, {
              ...currentReq,
              endLineIndex: i,
            });
          }

          const rawTitle = (reqMatch[2] ?? '').trim();
          const attrStr = reqMatch[3];
          const [rawId] = (attrStr ?? '').trim().split(/\s+/);
          const reqId = rawId && rawId !== '' ? rawId : slugify(rawTitle);

          currentReq = {
            id: reqId,
            title: rawTitle,
            filePath,
            lineIndex: i,
            items: [],
            endLineIndex: lines.length,
          };
          requirements.set(reqId, currentReq);
          actionsHeadingIndex = undefined;
          continue;
        }

        if (currentReq !== undefined && NEXT_HEADING.test(line)) {
          requirements.set(currentReq.id, {
            ...currentReq,
            endLineIndex: i,
          });
          currentReq = undefined;
          continue;
        }

        if (currentReq !== undefined) {
          if (ACTIONS_HEADING.test(line)) {
            actionsHeadingIndex = i;
            continue;
          }

          const itemMatch = CHECKLIST_OR_ACTION_ITEM.exec(line);
          if (itemMatch !== null) {
            const hasExplicitCheckbox = itemMatch[2] !== undefined;
            const isChecked = hasExplicitCheckbox && itemMatch[2]?.toLowerCase() === 'x';
            const itemText = (itemMatch[3] ?? '').trim();
            const attrStr = itemMatch[4];
            const [rawId] = (attrStr ?? '').trim().split(/\s+/);

            // Generate an id if not specified: reqId.1, reqId.2, etc.
            const itemIndex = currentReq.items.length + 1;
            const itemId = rawId && rawId !== '' ? rawId : `${currentReq.id}.${itemIndex}`;

            const parsedItem: ParsedChecklistItem = {
              id: itemId,
              title: itemText,
              state: isChecked ? 'closed' : 'open',
              rawState: isChecked ? '[x]' : '[ ]',
              filePath,
              lineIndex: i,
              reqId: currentReq.id,
              hasExplicitCheckbox,
            };

            currentReq.items.push(parsedItem);
            items.set(itemId, parsedItem);
            // Also register under itemText slug if distinct
            const textSlug = slugify(itemText);
            if (textSlug !== '' && !items.has(textSlug)) {
              items.set(textSlug, parsedItem);
            }
          }
        }
      }

      if (currentReq !== undefined) {
        requirements.set(currentReq.id, {
          ...currentReq,
          actionsHeadingLineIndex: actionsHeadingIndex,
          endLineIndex: lines.length,
        });
      }
    }

    return { requirements, items };
  }

  async #discoverFiles(): Promise<readonly string[]> {
    if (this.#options.files !== undefined && this.#options.files.length > 0) {
      return this.#options.files;
    }
    if (this.#options.listFiles !== undefined) {
      return this.#options.listFiles();
    }
    const dir = this.#options.plansDir ?? 'plans';
    if (!existsSync(dir)) return [];
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => join(dir, e.name));
    } catch {
      return [];
    }
  }

  async #read(filePath: string): Promise<string> {
    if (this.#options.readFile !== undefined) {
      return this.#options.readFile(filePath);
    }
    return readFileSync(filePath, 'utf8');
  }

  async #write(filePath: string, content: string): Promise<void> {
    if (this.#options.writeFile !== undefined) {
      await this.#options.writeFile(filePath, content);
      return;
    }
    writeFileSync(filePath, content, 'utf8');
  }
}
