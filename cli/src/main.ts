import { writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import {
  type AbandonResult,
  type ArchiveResult,
  abandonChange,
  archiveChange,
  type ChangeProblem,
  type CheckReport,
  check,
  ensureGitAttributes,
  type FileReport,
  type IngestReport,
  ingest,
  loadPlanFiles,
  type OpenChangeResult,
  openChange,
  openWorkspace,
  refresh,
  type StatusReport,
  settleChangeFile,
  status,
  VERSION,
  type Workspace,
} from '@cntxt-labs/yojana';
import { foldLog, type VerifierPort, YojanaError } from '@cntxt-labs/yojana-core';
import { AnvesaVerifier, PathVerifier, spawnAnvesa, TextVerifier } from '@cntxt-labs/yojana-verify';
import { BdWorkLink, spawnBd } from '@cntxt-labs/yojana-work';

const USAGE = `yojana ${VERSION}: plans as checkable contracts

Usage:
  yojana ingest [--trust-file]              record edits to plan files
  yojana change open <file>                 open a change file against the log
  yojana changes [--all]                    list open changes (--all: closed ones too)
  yojana archive <change>                   apply a change if what it edits has not moved
  yojana abandon <change> --reason <text>   close a change without applying it
  yojana refresh                            bring log changes into plan files that fell behind
  yojana status [plan] [--check]            plans, progress, pending edits, open changes
  yojana repair                             keep a corrupt log's readable events, move the rest aside
  yojana check [plan] [--strict]            verify plan claims against the code
  yojana --version

Options:
  --root <dir>       repository root (default: current directory)
  --plans <dir>      plan folder, relative to the root (default: plans)
  --changes <dir>    change folder, relative to the root (default: changes)
  --json             machine-readable output
  --strict           check: also fail when a claim cannot be verified
  --check            status: also run the claim checks
  --stale-days <n>   status: an open change older than this is stale (default 14)

Exit codes: 0 done; 1 refused, violated, invalid or failed (the output says which); 2 usage error.
Errors carry a code (STORE_CORRUPT, CLI_USAGE, ...) and usually a hint; with --json they are
printed as {"error": {"code", "message", "hint"}}.

Claims run through anvesa (wql, dependents) and progress through bd; set ANVESA_BIN or BD_BIN if
they are not on PATH.
`;

type Write = (text: string) => void;

/** An open change older than this many days is reported stale; --stale-days overrides it. */
const DEFAULT_STALE_DAYS = 14;

interface Flags {
  readonly root: string;
  readonly plans: string | undefined;
  readonly changes: string | undefined;
  readonly json: boolean;
  readonly trustFile: boolean;
  readonly all: boolean;
  readonly strict: boolean;
  readonly runCheck: boolean;
  readonly staleDays: number;
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
    strict: false,
    runCheck: false,
    staleDays: DEFAULT_STALE_DAYS,
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
    else if (arg === '--strict') flags.strict = true;
    else if (arg === '--check') flags.runCheck = true;
    else if (arg === '--stale-days') {
      const days = Number(value());
      if (!Number.isInteger(days) || days < 0) {
        throw new YojanaError('CLI_USAGE', '--stale-days needs a whole number of days');
      }
      flags.staleDays = days;
    } else if (arg.startsWith('--')) throw new YojanaError('CLI_USAGE', `unknown option ${arg}`);
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
  body: (workspace: Workspace) => Promise<number>,
  options?: { readonly allowCorrupt?: boolean },
): Promise<number> {
  const workspace = openWorkspace(flags.root, { plansDir: flags.plans, changesDir: flags.changes });
  const opened = await workspace.store.open();
  ensureGitAttributes(flags.root);
  if (opened.status === 'corrupt' && options?.allowCorrupt !== true) {
    await workspace.store.close();
    throw new YojanaError(
      'STORE_CORRUPT',
      `${opened.source} is unreadable from event ${opened.atSeq}; nothing was done`,
      { hint: 'run yojana repair: it keeps every readable event and moves the rest aside' },
    );
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
  return withWorkspace(flags, async (ws) => {
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
  return withWorkspace(flags, async (ws) => {
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
  return withWorkspace(flags, async (ws) => {
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
  return withWorkspace(flags, async (ws) => {
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

// check

function describeCheck(report: CheckReport): string {
  if (report.plans.length === 0) return 'no plans in the log; run yojana ingest first\n';
  const lines: string[] = [];
  for (const plan of report.plans) {
    lines.push(plan.planId);
    if (plan.results.length === 0) lines.push('  no claims');
    for (const r of plan.results) {
      const expectation = r.claim.expect ? '' : ' (expect none)';
      lines.push(
        `  ${r.requirement}  ${r.outcome}  ${r.claim.kind} ${r.claim.expression}${expectation}`,
      );
      lines.push(`      ${r.evidence}`);
    }
  }
  lines.push(
    '',
    `${report.holds} hold · ${report.violated} violated · ${report.unverifiable} could not be checked`,
  );
  return `${lines.join('\n')}\n`;
}

function verifiers(root: string): VerifierPort[] {
  return [
    new PathVerifier(root),
    new TextVerifier(root),
    new AnvesaVerifier(spawnAnvesa(process.env.ANVESA_BIN ?? 'anvesa', root)),
  ];
}

function runCheck(flags: Flags, write: Write): Promise<number> {
  const [planId] = flags.positional;
  return withWorkspace(flags, async (ws) => {
    const report = await check({ store: ws.store, verifiers: verifiers(flags.root), planId });
    emit(flags, write, report, describeCheck(report));
    if (report.violated > 0) return 1;
    return flags.strict && report.unverifiable > 0 ? 1 : 0;
  });
}

// repair

function runRepair(flags: Flags, write: Write): Promise<number> {
  return withWorkspace(
    flags,
    async (ws) => {
      const result = await ws.repairLog();
      const text =
        result.quarantined === undefined
          ? `the log is readable (${result.kept} events); nothing to repair\n`
          : `kept ${result.kept} readable events; moved the unreadable rest to ${toSource(flags.root, result.quarantined)}\n`;
      emit(flags, write, result, text);
      return 0;
    },
    { allowCorrupt: true },
  );
}

// refresh

function runRefresh(flags: Flags, write: Write): Promise<number> {
  return withWorkspace(flags, async (ws) => {
    const report = await refresh({
      store: ws.store,
      parser: ws.parser,
      bases: ws.bases,
      files: loadPlanFiles(flags.root, ws.plansDir),
      writePlan: (source, text) => writeFileSync(join(flags.root, source), text),
    });
    const lines =
      report.files.length === 0
        ? ['every plan file is up to date with the log']
        : report.files.flatMap((f) => {
            const what = [
              f.updated.length > 0 ? `updated ${f.updated.join(', ')}` : '',
              f.added.length > 0 ? `added ${f.added.join(', ')}` : '',
              f.removed.length > 0 ? `removed ${f.removed.join(', ')}` : '',
              f.status === undefined ? '' : `status ${f.status.from} -> ${f.status.to}`,
            ].filter((s) => s !== '');
            return [`${f.source}  ${what.join(' · ')}`];
          });
    emit(flags, write, report, `${lines.join('\n')}\n`);
    return 0;
  });
}

// status

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 'yyyy-mm-dd'.length);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function describeStatus(report: StatusReport, checks: CheckReport | undefined): string {
  const lines: string[] = [];
  if (report.plans.length === 0) lines.push('no plans in the log; run yojana ingest first');
  for (const plan of report.plans) {
    const since = plan.statusSince === undefined ? '' : ` since ${day(plan.statusSince)}`;
    lines.push(
      `${plan.planId}  ${plan.status}${since}  ${plural(plan.requirements, 'requirement')}, ${plural(plan.claims, 'claim')}`,
    );

    const p = plan.progress;
    if (p?.error !== undefined) lines.push(`  progress   could not read beads: ${p.error}`);
    else if (p !== undefined && p.items.length > 0) {
      const parts = p.items.map((i) => {
        if (i.item.state === 'missing') return `${i.item.id} missing`;
        if (i.children.length === 0) return `${i.item.id} ${i.item.state}`;
        const done = i.children.filter((c) => c.state === 'closed').length;
        return `${i.item.id} ${done}/${i.children.length}`;
      });
      lines.push(`  progress   ${p.done}/${p.total} done (${parts.join(', ')})`);
    }

    const f = plan.file;
    if (f.kind === 'none') lines.push('  file       no plan file found for this plan');
    else {
      const pending = [
        f.unrecorded.length > 0 ? `not ingested: ${f.unrecorded.join(', ')}` : '',
        f.statusUnrecorded ? 'status not ingested' : '',
        f.workItemsUnrecorded ? 'bead list not ingested' : '',
        f.behind.length > 0 ? `behind the log: ${f.behind.join(', ')}` : '',
        f.conflicts.length > 0 ? `conflicts with the log: ${f.conflicts.join(', ')}` : '',
      ].filter((s) => s !== '');
      lines.push(
        `  file       ${f.source}  ${pending.length === 0 ? 'in step' : pending.join(' · ')}`,
      );
    }

    if (plan.contested.length > 0) {
      lines.push(
        `  contested  ${plan.contested.join(', ')} (edited on two branches; resolve in the plan file, then ingest)`,
      );
    }
    for (const c of plan.openChanges) {
      lines.push(
        `  change     ${c.id}  open ${plural(c.ageDays, 'day')}${c.stale ? '  STALE' : ''}  ${c.title}`,
      );
    }
    const planChecks = checks?.plans.find((c) => c.planId === plan.planId);
    if (planChecks !== undefined) {
      const n = (o: string) => planChecks.results.filter((r) => r.outcome === o).length;
      const violated = planChecks.results
        .filter((r) => r.outcome === 'violated')
        .map((r) => r.requirement);
      lines.push(
        `  claims     ${n('holds')} hold · ${n('violated')} violated · ${n('unverifiable')} could not be checked${violated.length > 0 ? `  (${[...new Set(violated)].join(', ')})` : ''}`,
      );
    }
    for (const a of plan.alignment) {
      if (a.mismatch === undefined) continue;
      const items = a.items.map((i) => `${i.id} ${i.state}`).join(', ');
      lines.push(
        a.mismatch === 'claims-hold-work-open'
          ? `  close?     ${a.requirement}: ${a.holds === 1 ? 'its claim holds' : `all ${a.holds} claims hold`}, but ${items}`
          : `  reopen?    ${a.requirement}: ${plural(a.violated, 'claim')} violated, but ${items}`,
      );
    }
  }
  for (const u of report.untracked) {
    const why =
      u.issues.length > 0
        ? u.issues
            .map((i) => `${i.line === undefined ? '' : `line ${i.line}: `}${i.code}`)
            .join(', ')
        : `plan ${u.planId} is not in the log yet; run yojana ingest`;
    lines.push(`untracked  ${u.source}  ${why}`);
  }
  if (report.anomalies.length > 0) {
    lines.push(
      '',
      `${plural(report.anomalies.length, 'anomaly')} in the log (yojana status --json lists them)`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function runStatus(flags: Flags, write: Write): Promise<number> {
  const [planId] = flags.positional;
  return withWorkspace(flags, async (ws) => {
    const checks = flags.runCheck
      ? await check({ store: ws.store, verifiers: verifiers(flags.root), planId })
      : undefined;
    const report = await status({
      store: ws.store,
      parser: ws.parser,
      bases: ws.bases,
      files: loadPlanFiles(flags.root, ws.plansDir),
      worklink: new BdWorkLink(spawnBd(process.env.BD_BIN ?? 'bd', flags.root)),
      checks,
      now: Date.now(),
      staleDays: flags.staleDays,
      planId,
    });
    emit(flags, write, { ...report, checks }, describeStatus(report, checks));
    return 0;
  });
}

// abandon

function runAbandon(flags: Flags, write: Write): Promise<number> {
  const [changeId] = flags.positional;
  if (changeId === undefined) {
    throw new YojanaError('CLI_USAGE', 'usage: yojana abandon <change> --reason <text>');
  }
  return withWorkspace(flags, async (ws) => {
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
    if (command === 'check') return await runCheck(flags(), write);
    if (command === 'status') return await runStatus(flags(), write);
    if (command === 'refresh') return await runRefresh(flags(), write);
    if (command === 'repair') return await runRepair(flags(), write);
  } catch (error) {
    if (error instanceof YojanaError) {
      const { code, message, hint } = error;
      write(
        rest.includes('--json')
          ? `${JSON.stringify({ error: { code, message, hint } }, null, 2)}\n`
          : `${code}: ${message}${hint === undefined ? '' : `\n  hint: ${hint}`}\n`,
      );
      return code === 'CLI_USAGE' ? 2 : 1;
    }
    throw error;
  }
  write(USAGE);
  return command === undefined || command === '--help' || command === '-h' ? 0 : 2;
}

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), (text) => process.stdout.write(text));
}
