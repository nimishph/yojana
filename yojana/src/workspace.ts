import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { BasePort, ParserPort, StorePort } from '@cntxt-labs/yojana-core';
import { MarkdownParser } from '@cntxt-labs/yojana-markdown';
import { FileBaseStore, FileStore } from '@cntxt-labs/yojana-store';
import type { PlanFile } from './ingest.ts';

/**
 * The default layout of a repository using yojana:
 *
 *   plans/                 plan files (Markdown), any depth
 *   .yojana/log.jsonl      the revision log
 *   .yojana/base/          one base per plan
 */
export interface Workspace {
  readonly root: string;
  readonly plansDir: string;
  readonly store: StorePort;
  readonly bases: BasePort;
  readonly parser: ParserPort;
}

export function openWorkspace(root: string, options?: { readonly plansDir?: string }): Workspace {
  return {
    root,
    plansDir: join(root, options?.plansDir ?? 'plans'),
    store: new FileStore({ path: join(root, '.yojana', 'log.jsonl') }),
    bases: new FileBaseStore({ dir: join(root, '.yojana', 'base') }),
    parser: new MarkdownParser(),
  };
}

/** Every `.md` file under `dir`, sorted, with sources relative to `root` using `/`. */
export function loadPlanFiles(root: string, dir: string): PlanFile[] {
  const files: PlanFile[] = [];
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
