import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import {
  type FileReport,
  type IngestReport,
  ingest,
  loadPlanFiles,
  openWorkspace,
  VERSION,
} from '@cntxt-labs/yojana';
import { YojanaError } from '@cntxt-labs/yojana-core';

const USAGE = `yojana ${VERSION}: plans as checkable contracts

Usage:
  yojana --version
  yojana ingest [--trust-file] [--json]   record revisions for edited plan files
  yojana status                           plans, open changes, stale work, drift   (v0)
  yojana archive <change>                 apply a change if its bases are current  (v0)
  yojana check [plan]                     verify plan claims against the code      (v0)

Options:
  --root <dir>    repository root (default: current directory)
  --plans <dir>   plan folder, relative to the root (default: plans)
  --json          machine-readable output
`;

type Write = (text: string) => void;

interface Flags {
  readonly root: string;
  readonly plans: string | undefined;
  readonly json: boolean;
  readonly trustFile: boolean;
  readonly positional: readonly string[];
}

function parseFlags(argv: readonly string[]): Flags {
  let root = process.cwd();
  let plans: string | undefined;
  let json = false;
  let trustFile = false;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new YojanaError('CLI_USAGE', `${arg} needs a value`);
      return next;
    };
    if (arg === '--root') root = resolve(value());
    else if (arg === '--plans') plans = value();
    else if (arg === '--json') json = true;
    else if (arg === '--trust-file') trustFile = true;
    else if (arg.startsWith('--')) throw new YojanaError('CLI_USAGE', `unknown option ${arg}`);
    else positional.push(arg);
  }
  return { root, plans, json, trustFile, positional };
}

function actor(): string {
  return process.env.YOJANA_ACTOR ?? userInfo().username;
}

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
  if (file.status !== undefined) {
    const s = file.status;
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
  const behind = report.files.some((f) => f.requirements.some((r) => r.movement === 'behind'));
  const refused = report.files.some((f) => f.outcome === 'refused');
  if (behind)
    lines.push(
      '',
      'behind: the log changed since the file was last ingested; the file was left as it is',
    );
  if (refused) {
    lines.push(
      '',
      'refused: the file and the log both changed the same thing; nothing from that file was recorded',
    );
  }
  return `${lines.join('\n')}\n`;
}

async function runIngest(flags: Flags, write: Write): Promise<number> {
  const workspace = openWorkspace(
    flags.root,
    flags.plans === undefined ? undefined : { plansDir: flags.plans },
  );
  const opened = await workspace.store.open();
  if (opened.status === 'corrupt') {
    write(`${opened.source} is unreadable from event ${opened.atSeq}; nothing was ingested\n`);
    return 1;
  }
  try {
    const report = await ingest({
      store: workspace.store,
      parser: workspace.parser,
      bases: workspace.bases,
      files: loadPlanFiles(flags.root, workspace.plansDir),
      actor: actor(),
      trustFile: flags.trustFile,
    });
    write(flags.json ? `${JSON.stringify(report, null, 2)}\n` : describeIngest(report));
    return report.files.some((f) => f.outcome === 'refused' || f.outcome === 'invalid') ? 1 : 0;
  } finally {
    await workspace.store.close();
  }
}

export async function run(argv: readonly string[], write: Write): Promise<number> {
  const [command, ...rest] = argv;
  if (command === '--version' || command === '-v') {
    write(`${VERSION}\n`);
    return 0;
  }
  try {
    if (command === 'ingest') return await runIngest(parseFlags(rest), write);
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
