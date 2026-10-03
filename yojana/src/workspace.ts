import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import type { BasePort, ParserPort, StorePort } from '@cntxt-labs/yojana-core';
import { MarkdownParser } from '@cntxt-labs/yojana-markdown';
import { FileBaseStore, FileStore, type RepairResult } from '@cntxt-labs/yojana-store';
import type { PlanFile } from './ingest.ts';

/**
 * The default layout of a repository using yojana:
 *
 *   plans/                 plan files (Markdown), any depth
 *   changes/               open change files; closed ones move to changes/archive/ and
 *                          changes/abandoned/, prefixed with the date
 *   .yojana/log.jsonl      the revision log
 *   .yojana/base/          one base per plan
 */
export interface Workspace {
  readonly root: string;
  readonly plansDir: string;
  readonly changesDir: string;
  readonly store: StorePort;
  readonly bases: BasePort;
  readonly parser: ParserPort;
  /** Keep every readable event of a corrupt log and move the rest to a side file. */
  repairLog(): Promise<RepairResult>;
}

export function openWorkspace(
  root: string,
  options?: { readonly plansDir?: string | undefined; readonly changesDir?: string | undefined },
): Workspace {
  const store = new FileStore({ path: join(root, '.yojana', 'log.jsonl') });
  return {
    root,
    plansDir: join(root, options?.plansDir ?? 'plans'),
    changesDir: join(root, options?.changesDir ?? 'changes'),
    store,
    bases: new FileBaseStore({ dir: join(root, '.yojana', 'base') }),
    parser: new MarkdownParser(),
    repairLog: () => store.repair(),
  };
}

/** Every `.md` file under `dir`, sorted, with sources relative to `root` using `/`. */
export function loadPlanFiles(root: string, dir: string): PlanFile[] {
  const files: PlanFile[] = [];
  if (!existsSync(dir)) return files;
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.md')) {
        files.push({
          source: relative(root, path).split(sep).join('/'),
          text: readFileSync(path, 'utf8'),
        });
      }
    }
  };
  walk(dir);
  return files;
}

/**
 * Move a closed change's file out of the way: `changes/x.md` becomes
 * `changes/<folder>/<yyyy-mm-dd>-x.md`. Returns the new path relative to `root`, or undefined when
 * the file is no longer there (moved or deleted by hand); the log keeps the change either way.
 */
export function settleChangeFile(
  root: string,
  source: string,
  folder: 'archive' | 'abandoned',
  date: Date,
): string | undefined {
  const from = join(root, source);
  if (!existsSync(from)) return undefined;
  const dir = join(from, '..', folder);
  mkdirSync(dir, { recursive: true });
  const to = join(dir, `${date.toISOString().slice(0, 'yyyy-mm-dd'.length)}-${basename(from)}`);
  renameSync(from, to);
  return relative(root, to).split(sep).join('/');
}

const GIT_ATTRIBUTES = `# Written by yojana. The log and the bases hold one fact per line, so git can merge two branches
# by keeping both sides' lines; yojana reads the result and reports any requirement both edited.
log.jsonl merge=union
base/*.jsonl merge=union
`;

/** Make sure `.yojana/.gitattributes` turns on union merges for the log and the bases. */
export function ensureGitAttributes(root: string): void {
  mkdirSync(join(root, '.yojana'), { recursive: true });
  const attributes = join(root, '.yojana', '.gitattributes');
  if (!existsSync(attributes)) writeFileSync(attributes, GIT_ATTRIBUTES);
  // Review pages are generated from the log and plans; they are not history.
  const ignore = join(root, '.yojana', '.gitignore');
  if (!existsSync(ignore))
    writeFileSync(ignore, '# Written by yojana: generated review pages.\nreview/\n');
}
