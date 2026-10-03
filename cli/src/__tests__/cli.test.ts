import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../main.ts';

const PLAN = `---
id: plan/demo
status: accepted
beads: [demo-1]
---

## Requirement: has a readme {#readme}

The repository has a README.

\`\`\`yojana:claim
kind: path
expression: README.md
\`\`\`

## Requirement: parser exists {#parser}

\`\`\`yojana:claim
kind: wql
expression: //function[@name="parse"]
\`\`\`
`;

const CHANGE = `---
id: add-license
plan: plan/demo
title: Ship a license
---

## ADDED Requirement: has a license {#license}

\`\`\`yojana:claim
kind: path
expression: LICENSE
\`\`\`
`;

const saved = { ...process.env };
let root = '';

beforeAll(() => {
  process.env.YOJANA_ACTOR = 'tester';
  // Neither tool is available, so their paths through the CLI are exercised too.
  process.env.ANVESA_BIN = join(tmpdir(), 'no-such-anvesa');
  process.env.BD_BIN = join(tmpdir(), 'no-such-bd');
  root = mkdtempSync(join(tmpdir(), 'yojana-cli-'));
  mkdirSync(join(root, 'plans'));
  mkdirSync(join(root, 'changes'));
  writeFileSync(join(root, 'plans', 'demo.md'), PLAN);
  writeFileSync(join(root, 'changes', 'add-license.md'), CHANGE);
  writeFileSync(join(root, 'LICENSE'), 'MIT');
});

afterAll(() => {
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
});

async function yojana(...args: string[]): Promise<{ code: number; out: string }> {
  let out = '';
  const code = await run([...args, '--root', root], (text) => {
    out += text;
  });
  return { code, out };
}

describe('yojana CLI, start to finish', () => {
  test('--version and help', async () => {
    const version = await yojana('--version');
    expect(version).toEqual({ code: 0, out: '0.0.0\n' });
    const help = await yojana('--help');
    expect(help.code).toBe(0);
    expect(help.out).toContain('Exit codes:');
  });

  test('ingest records the plan and writes .gitattributes', async () => {
    const result = await yojana('ingest');
    expect(result.code).toBe(0);
    expect(result.out).toContain('recorded (4 events)');
    expect(readFileSync(join(root, '.yojana', '.gitattributes'), 'utf8')).toContain(
      'log.jsonl merge=union',
    );
    expect((await yojana('ingest')).out).toContain('unchanged');
  });

  test('status --json: in step, and an unreachable bd is reported, not shown as 0%', async () => {
    const result = await yojana('status', '--json');
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    expect(report.plans[0]).toMatchObject({
      planId: 'plan/demo',
      status: 'accepted',
      requirements: 2,
      file: { kind: 'file', unrecorded: [], behind: [] },
    });
    expect(report.plans[0].progress.error).toContain('could not run bd');
  });

  test('change open, then archive: plan file updated, change file moved', async () => {
    expect((await yojana('change', 'open', 'changes/add-license.md')).code).toBe(0);
    expect((await yojana('changes')).out).toContain('add-license  open');
    const archived = await yojana('archive', 'add-license');
    expect(archived.code).toBe(0);
    expect(readFileSync(join(root, 'plans', 'demo.md'), 'utf8')).toContain('{#license}');
    expect(existsSync(join(root, 'changes', 'add-license.md'))).toBe(false);
    expect(readdirSync(join(root, 'changes', 'archive'))[0]).toMatch(/-add-license\.md$/);
  });

  test('check: a broken claim exits 1; an unverifiable one fails only with --strict', async () => {
    const broken = await yojana('check');
    expect(broken.code).toBe(1);
    expect(broken.out).toContain('readme  violated  path README.md');
    expect(broken.out).toContain('parser  unverifiable');

    writeFileSync(join(root, 'README.md'), '# demo');
    const lenient = await yojana('check');
    expect(lenient.code).toBe(0);
    expect(lenient.out).toContain('2 hold · 0 violated · 1 could not be checked');
    expect((await yojana('check', '--strict')).code).toBe(1);
  });

  test('usage errors exit 2, and come out as JSON with --json', async () => {
    const text = await yojana('status', '--bogus');
    expect(text).toMatchObject({ code: 2 });
    expect(text.out).toContain('CLI_USAGE: unknown option --bogus');
    const json = await yojana('status', '--bogus', '--json');
    expect(JSON.parse(json.out)).toEqual({
      error: { code: 'CLI_USAGE', message: 'unknown option --bogus' },
    });
    expect((await yojana('nonsense')).code).toBe(2);
  });

  test('a corrupt log stops every command with a hint; repair keeps the good events', async () => {
    appendFileSync(join(root, '.yojana', 'log.jsonl'), '{"torn":');
    const stopped = await yojana('status');
    expect(stopped.code).toBe(1);
    expect(stopped.out).toContain('STORE_CORRUPT');
    expect(stopped.out).toContain('hint: run yojana repair');

    const repaired = await yojana('repair');
    expect(repaired.code).toBe(0);
    expect(repaired.out).toMatch(/kept \d+ readable events; moved the unreadable rest to/);
    expect((await yojana('status')).code).toBe(0);
    expect((await yojana('repair')).out).toContain('nothing to repair');
  });
});
