import { writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import {
  type AbandonResult,
  type ArchiveResult,
  abandonChange,
  archiveChange,
  type ChangeProblem,
  ensureGitAttributes,
  type FileReport,
  type IngestReport,
  ingest,
  loadPlanFiles,
  type OpenChangeResult,
  openChange,
  openWorkspace,
  settleChangeFile,
  VERSION,
  type Workspace,
} from '@cntxt-labs/yojana';
import { foldLog, YojanaError } from '@cntxt-labs/yojana-core';

const USAGE = `yojana ${VERSION}: plans as checkable contracts

Usage:
  yojana ingest [--trust-file]              record edits to plan files
  yojana change open <file>                 open a change file against the log
  yojana changes [--all]                    list open changes (--all: closed ones too)
  yojana archive <change>                   apply a change if what it edits has not moved
  yojana abandon <change> --reason <text>   close a change without applying it
  yojana status                             plans, progress, staleness, drift        (v0)
  yojana check [plan]                       verify plan claims against the code      (v0)
  yojana --version

Options:
  --root <dir>      repository root (default: current directory)
  --plans <dir>     plan folder, relative to the root (default: plans)
  --changes <dir>   change folder, relative to the root (default: changes)
  --json            machine-readable output
`;

type Write = (text: string) => void;

interface Flags {
  readonly root: string;
  readonly plans: string | undefined;
  readonly changes: string | undefined;
  readonly json: boolean;
  readonly trustFile: boolean;
  readonly all: boolean;
  readonly reason: string | undefined;
  readonly positional: readonly string[];
}

function parseFlags(argv: readonly string[]): Flags {
  const flags = {
    root: process.cwd(),
    plans: undefined as string | undefined,
    changes: undefined as string | undefined,
    json: false,
    trustFile: false,
    all: false,
    reason: undefined as string | undefined,
    positional: [] as string[],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new YojanaError('CLI_USAGE', `${arg} needs a value`);
      return next;
    };
    if (arg === '--root') flags.root = resolve(value());
    else if (arg === '--plans') flags.plans = value();
    else if (arg === '--changes') flags.changes = value();
    else if (arg === '--reason') flags.reason = value();
    else if (arg === '--json') flags.json = true;
    else if (arg === '--trust-file') flags.trustFile = true;
    else if (arg === '--all') flags.all = true;
    else if (arg.startsWith('--')) throw new YojanaError('CLI_USAGE', `unknown option ${arg}`);
    else flags.positional.push(arg);
  }
  return flags;
}

function actor(): string {
  return process.env.YOJANA_ACTOR ?? userInfo().username;
}

function toSource(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

/** Open the workspace and its log; refuse to go on with a corrupt log. */
async function withWorkspace(
  flags: Flags,
  write: Write,
  body: (workspace: Workspace) => Promise<number>,
): Promise<number> {
  const workspace = openWorkspace(flags.root, { plansDir: flags.plans, changesDir: flags.changes });
  const opened = await workspace.store.open();
  ensureGitAttributes(flags.root);
  if (opened.status === 'corrupt') {
    write(`${opened.source} is unreadable from event ${opened.atSeq}; nothing was done\n`);
    return 1;
  }
  try {
    return await body(workspace);
  } finally {
    await workspace.store.close();
  }
}

function emit(flags: Flags, write: Write, value: unknown, text: string): void {
  write(flags.json ? `${JSON.stringify(value, null, 2)}\n` : text);
}

function describeProblems(problems: readonly ChangeProblem[]): string[] {
  return problems.map(
    (p) => `  ${p.requirement === undefined ? '' : `${p.requirement}  `}${p.code}  ${p.message}`,
  );
}

// ingest

function describeFile(file: FileReport): string[] {
  const count =
    file.appended === 1 ? ' (1 event)' : file.appended > 1 ? ` (${file.appended} events)` : '';
  const head = `${file.source}  ${file.outcome}${count}`;
  const lines = [file.planId === undefined ? head : `${head}  ${file.planId}`];
  for (const issue of file.issues) {
    lines.push(
      `  ${issue.line === undefined ? '' : `line ${issue.line}: `}${issue.code} ${issue.message}`,
    );
  }
  if (file.missingBase && file.outcome === 'refused') {
    lines.push(
      '  no base for this plan: re-run with --trust-file to record the file on top of the log',
    );
  }
  const s = file.status;
  if (s !== undefined && s.log === undefined && s.movement === 'edited') {
    lines.push(`  status  ${s.file}  (new plan)`);
  } else if (s !== undefined) {
    lines.push(
      `  status  ${s.movement}  file ${s.file} · base ${s.base ?? '-'} · log ${s.log ?? '-'}`,
    );
  }
  for (const r of file.requirements) {
    const what = r.movement === 'edited' ? (r.action ?? 'edited') : r.movement;
    const detail =
      r.movement === 'edited'
        ? ''
        : `  file ${r.file ?? '-'} · base ${r.base ?? '-'} · log ${r.log ?? '-'}`;
    lines.push(`  ${r.id}  ${what}${detail}`);
  }
  return lines;
}

function describeIngest(report: IngestReport): string {
  if (report.files.length === 0) return 'no plan files found\n';
  const lines = report.files.flatMap(describeFile);
  if (report.files.some((f) => f.requirements.some((r) => r.movement === 'behind'))) {
    lines.push(
      '',
      'behind: the log changed since the file was last ingested; the file was left as it is',
    );
  }
  if (report.files.some((f) => f.outcome === 'refused')) {
    lines.push(
      '',
      'refused: the file and the log both changed the same thing; nothing from that file was recorded',
    );
  }
  return `${lines.join('\n')}\n`;
}

function runIngest(flags: Flags, write: Write): Promise<number> {
  return withWorkspace(flags, write, async (ws) => {
    const report = await ingest({
      store: ws.store,
      parser: ws.parser,
      bases: ws.bases,
      files: loadPlanFiles(flags.root, ws.plansDir),
      actor: actor(),
      trustFile: flags.trustFile,
    });
    emit(flags, write, report, describeIngest(report));
    return report.files.some((f) => f.outcome === 'refused' || f.outcome === 'invalid') ? 1 : 0;
  });
}

// change open

function runChangeOpen(flags: Flags, write: Write): Promise<number> {
  const [, file] = flags.positional;
  if (file === undefined) throw new YojanaError('CLI_USAGE', 'usage: yojana change open <file>');
  return withWorkspace(flags, write, async (ws) => {
    const path = resolve(flags.root, file);
    const source = toSource(flags.root, path);
    let text: string;
    try {
      text = await Bun.file(path).text();
    } catch (error) {
      throw new YojanaError('FILE_NOT_FOUND', `cannot read ${source}`, { cause: error });
    }
    const parsed = ws.parser.parseChange(source, text);
    if (!parsed.ok) {
      const lines = parsed.issues.map(
        (i) => `  ${i.line === undefined ? '' : `line ${i.line}: `}${i.code} ${i.message}`,
      );
      emit(flags, write, parsed, `${source}  invalid\n${lines.join('\n')}\n`);
      return 1;
    }
    const result: OpenChangeResult = await openChange({
      store: ws.store,
      draft: parsed.change,
      actor: actor(),
    });
    const lines = [`${parsed.change.id}  ${result.outcome}  ${parsed.change.planId}`];
    if (result.outcome === 'opened') {
      for (const d of result.change?.deltas ?? []) {
        const id = d.op === 'remove' ? d.id : d.requirement.id;
        lines.push(`  ${id}  ${d.op}${d.base === undefined ? '' : `  on ${d.base}`}`);
      }
    }
    lines.push(...describeProblems(result.problems));
    emit(flags, write, result, `${lines.join('\n')}\n`);
    return result.outcome === 'opened' ? 0 : 1;
  });
}

// changes

function runChanges(flags: Flags, write: Write): Promise<number> {
  return withWorkspace(flags, write, async (ws) => {
    const state = foldLog(await ws.store.events());
    const rows = [...state.changes.values()].filter((c) => flags.all || c.status === 'open');
    const value = rows.map((c) => ({
      id: c.change.id,
      plan: c.change.planId,
      title: c.change.title,
      status: c.status,
      openedAt: new Date(c.openedAt).toISOString(),
      deltas: c.change.deltas.length,
      reason: c.reason,
    }));
    const lines =
      rows.length === 0
        ? [flags.all ? 'no changes' : 'no open changes']
        : value.map(
            (c) =>
              `${c.id}  ${c.status}  ${c.plan}  ${c.deltas} edit${c.deltas === 1 ? '' : 's'}  opened ${c.openedAt.slice(0, 'yyyy-mm-dd'.length)}  ${c.title}${c.reason === undefined ? '' : `  (${c.reason})`}`,
          );
    emit(flags, write, value, `${lines.join('\n')}\n`);
    return 0;
  });
}

// archive

function runArchive(flags: Flags, write: Write): Promise<number> {
  const [changeId] = flags.positional;
  if (changeId === undefined) throw new YojanaError('CLI_USAGE', 'usage: yojana archive <change>');
  return withWorkspace(flags, write, async (ws) => {
    const result: ArchiveResult = await archiveChange({
      store: ws.store,
      bases: ws.bases,
      parser: ws.parser,
      changeId,
      actor: actor(),
      planFiles: loadPlanFiles(flags.root, ws.plansDir),
      writePlan: (source, text) => writeFileSync(join(flags.root, source), text),
    });
    const lines = [`${changeId}  ${result.outcome}`];
    lines.push(...describeProblems(result.problems));
    for (const c of result.conflicts) {
      lines.push(
        `  ${c.requirement}  ${c.op}  written against ${c.expected ?? 'no requirement'}, the plan now has ${c.actual ?? 'none'}`,
      );
    }
    if (result.conflicts.length > 0) {
      lines.push(
        '',
        'another change or edit got there first. Rewrite this change against the current plan and open it under a new id, or abandon it.',
      );
    }
    let moved: string | undefined;
    if (result.outcome === 'archived') {
      const file = result.planFile;
      if (file?.updated === true) lines.push(`  ${file.source}  updated to match`);
      else if (file?.reason === 'out-of-step') {
        lines.push(
          `  ${file.source}  not updated: it has edits the log does not (run ingest, then edit it by hand)`,
        );
      } else lines.push('  no plan file found for this plan; only the log was updated');
      const source = result.change?.source;
      if (source !== undefined) {
        moved = settleChangeFile(flags.root, source, 'archive', new Date());
        if (moved !== undefined) lines.push(`  ${source}  moved to ${moved}`);
      }
    }
    emit(flags, write, { ...result, movedTo: moved }, `${lines.join('\n')}\n`);
    return result.outcome === 'archived' ? 0 : 1;
  });
}

// abandon

function runAbandon(flags: Flags, write: Write): Promise<number> {
  const [changeId] = flags.positional;
  if (changeId === undefined) {
    throw new YojanaError('CLI_USAGE', 'usage: yojana abandon <change> --reason <text>');
  }
  return withWorkspace(flags, write, async (ws) => {
    const result: AbandonResult = await abandonChange({
      store: ws.store,
      changeId,
      reason: flags.reason ?? '',
      actor: actor(),
    });
    const lines = [`${changeId}  ${result.outcome}`, ...describeProblems(result.problems)];
    let moved: string | undefined;
    const source = result.change?.source;
    if (result.outcome === 'abandoned' && source !== undefined) {
      moved = settleChangeFile(flags.root, source, 'abandoned', new Date());
      if (moved !== undefined) lines.push(`  ${source}  moved to ${moved}`);
    }
    emit(flags, write, { ...result, movedTo: moved }, `${lines.join('\n')}\n`);
    return result.outcome === 'abandoned' ? 0 : 1;
  });
}

export async function run(argv: readonly string[], write: Write): Promise<number> {
  const [command, ...rest] = argv;
  if (command === '--version' || command === '-v') {
    write(`${VERSION}\n`);
    return 0;
  }
  try {
    const flags = () => parseFlags(rest);
    if (command === 'ingest') return await runIngest(flags(), write);
    if (command === 'change' && rest[0] === 'open') return await runChangeOpen(flags(), write);
    if (command === 'changes') return await runChanges(flags(), write);
    if (command === 'archive') return await runArchive(flags(), write);
    if (command === 'abandon') return await runAbandon(flags(), write);
  } catch (error) {
    if (error instanceof YojanaError) {
      write(
        `${error.code}: ${error.message}${error.hint === undefined ? '' : `\n  hint: ${error.hint}`}\n`,
      );
      return error.code === 'CLI_USAGE' ? 2 : 1;
    }
    throw error;
  }
  write(USAGE);
  return command === undefined || command === '--help' || command === '-h' ? 0 : 2;
}

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), (text) => process.stdout.write(text));
}
