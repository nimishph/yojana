import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Claim, YojanaError } from '@cntxt-labs/yojana-core';
import { type AnvesaRunner, AnvesaVerifier } from '../anvesa.ts';
import { PathVerifier } from '../path.ts';
import { TextVerifier } from '../text.ts';

// Output shapes below are copied from anvesa 0.6.0 (`--json`).
const queryHit = {
  items: [{ path: 'cli/src/errors.ts', tag: 'class', name: 'CommandFailedError', startLine: 8 }],
  total: null,
  nextCursor: 'x',
};
const queryMiss = { items: [], total: 0, nextCursor: null };
const notIndexed = {
  error: {
    code: 'RETRIEVER_NOT_INDEXED',
    message: '/repo has no index yet',
    hint: 'Run: anvesa index',
  },
};
const unknownTag = {
  error: {
    code: 'STRUCTURAL_WQL_UNKNOWN_NAME',
    message: 'Invalid WQL: tag "file" is not one this project has',
  },
};
const dependents = {
  dependents: [
    { path: 'cli/src/cli.ts', depth: 1 },
    { path: 'cli/src/commands.ts', depth: 1 },
    { path: 'core/src/other.ts', depth: 2 },
  ],
  total: 3,
  moreBeyondDepth: false,
};

function runner(output: unknown, seen: string[][] = []): AnvesaRunner {
  return async (args) => {
    seen.push([...args]);
    return { exitCode: 0, stdout: JSON.stringify(output), stderr: '' };
  };
}

const claim = (kind: string, expression: string, expect = true): Claim => ({
  kind,
  expression,
  expect,
});

describe('AnvesaVerifier: wql', () => {
  test('a match holds when expected, with where it matched', async () => {
    const seen: string[][] = [];
    const result = await new AnvesaVerifier(runner(queryHit, seen)).verify(
      'r',
      claim('wql', '//class[@name="CommandFailedError"]'),
    );
    expect(result).toMatchObject({ outcome: 'holds', evidence: 'matches cli/src/errors.ts:8' });
    expect(seen[0]).toEqual(['query', '//class[@name="CommandFailedError"]', '--limit', '1']);
  });

  test('no match violates expect: true and holds expect: false', async () => {
    const verifier = new AnvesaVerifier(runner(queryMiss));
    expect((await verifier.verify('r', claim('wql', '//x'))).outcome).toBe('violated');
    expect((await verifier.verify('r', claim('wql', '//x', false))).outcome).toBe('holds');
  });

  test("anvesa's errors make the claim unverifiable, with its message and hint", async () => {
    const missing = await new AnvesaVerifier(runner(notIndexed)).verify('r', claim('wql', '//x'));
    expect(missing).toMatchObject({
      outcome: 'unverifiable',
      evidence: 'RETRIEVER_NOT_INDEXED: /repo has no index yet (Run: anvesa index)',
    });
    const bad = await new AnvesaVerifier(runner(unknownTag)).verify('r', claim('wql', '//file'));
    expect(bad.outcome).toBe('unverifiable');
    expect(bad.evidence).toContain('STRUCTURAL_WQL_UNKNOWN_NAME');
  });

  test('an error reported as JSON on stderr is read like one on stdout', async () => {
    const onStderr: AnvesaRunner = async () => ({
      exitCode: 1,
      stdout: '',
      stderr: JSON.stringify(unknownTag),
    });
    expect(await new AnvesaVerifier(onStderr).verify('r', claim('wql', '//file'))).toMatchObject({
      outcome: 'unverifiable',
      evidence: 'STRUCTURAL_WQL_UNKNOWN_NAME: Invalid WQL: tag "file" is not one this project has',
    });
  });

  test('anvesa not installed, or answering in something other than JSON, is unverifiable', async () => {
    const absent: AnvesaRunner = async () => {
      throw new YojanaError('TEST_SPAWN', 'Executable not found in $PATH: "anvesa"');
    };
    expect(await new AnvesaVerifier(absent).verify('r', claim('wql', '//x'))).toMatchObject({
      outcome: 'unverifiable',
      evidence: expect.stringContaining('set ANVESA_BIN'),
    });
    const garbled: AnvesaRunner = async () => ({ exitCode: 2, stdout: '', stderr: 'boom' });
    expect(await new AnvesaVerifier(garbled).verify('r', claim('wql', '//x'))).toMatchObject({
      outcome: 'unverifiable',
      evidence: expect.stringContaining('exit 2'),
    });
  });
});

describe('AnvesaVerifier: wql scoped to a folder', () => {
  const imports = {
    items: [
      { path: 'cli/src/cli.ts', tag: 'import', name: "'@cntxt-labs/anvesa-core'", startLine: 3 },
      { path: 'core/src/x.ts', tag: 'import', name: "'../../cli/src/y.ts'", startLine: 9 },
    ],
  };

  test('fetches every match and keeps those under the folder', async () => {
    const seen: string[][] = [];
    const verifier = new AnvesaVerifier(runner(imports, seen));
    const result = await verifier.verify(
      'r',
      claim('wql', '//import[contains(@name, "cli/")] in core/', false),
    );
    expect(seen[0]?.slice(0, 2)).toEqual(['query', '//import[contains(@name, "cli/")]']);
    expect(seen[0]?.[3]).not.toBe('1');
    expect(result).toMatchObject({
      outcome: 'violated',
      evidence: 'matches in core/ core/src/x.ts:9 (2 matches in all)',
    });
  });

  test('no match in the folder holds expect: false, and says how many matched elsewhere', async () => {
    const result = await new AnvesaVerifier(runner(imports)).verify(
      'r',
      claim('wql', '//import in docs/', false),
    );
    expect(result).toMatchObject({
      outcome: 'holds',
      evidence: 'no match in docs/ (2 matches in all)',
    });
  });
});

describe('AnvesaVerifier: dependents', () => {
  test('asks for every importer at every depth', async () => {
    const seen: string[][] = [];
    await new AnvesaVerifier(runner(dependents, seen)).verify(
      'r',
      claim('dependents', 'core/src/index.ts'),
    );
    expect(seen[0]?.slice(0, 2)).toEqual(['dependents', 'core/src/index.ts']);
    expect(seen[0]).toContain('--depth');
    expect(seen[0]).toContain('--limit');
  });

  test('"from <dir>" counts only importers under that folder', async () => {
    const verifier = new AnvesaVerifier(runner(dependents));
    const fromCore = await verifier.verify(
      'r',
      claim('dependents', 'cli/src/index.ts from core/', false),
    );
    expect(fromCore).toMatchObject({
      outcome: 'violated',
      evidence: 'imported under core/ by core/src/other.ts (1 file) (3 files import it in all)',
    });
    const fromDocs = await verifier.verify(
      'r',
      claim('dependents', 'cli/src/index.ts from docs/', false),
    );
    expect(fromDocs).toMatchObject({
      outcome: 'holds',
      evidence: 'nothing under docs/ imports it (3 files import it in all)',
    });
  });
});

describe('PathVerifier', () => {
  const root = mkdtempSync(join(tmpdir(), 'yojana-path-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), '{}');
  writeFileSync(join(root, 'a.md'), '');
  writeFileSync(join(root, 'b.md'), '');

  test('an existing path holds; a missing one is violated, or holds with expect: false', async () => {
    const verifier = new PathVerifier(root);
    expect(await verifier.verify('r', claim('path', '.claude-plugin/plugin.json'))).toMatchObject({
      outcome: 'holds',
      evidence: '1 match: .claude-plugin/plugin.json',
    });
    expect((await verifier.verify('r', claim('path', 'nope.json'))).outcome).toBe('violated');
    expect((await verifier.verify('r', claim('path', 'nope.json', false))).outcome).toBe('holds');
  });

  test('globs count their matches', async () => {
    const result = await new PathVerifier(root).verify('r', claim('path', '*.md'));
    expect(result).toMatchObject({ outcome: 'holds', evidence: '2 matches: a.md, b.md' });
  });
});

describe('AnvesaVerifier: wql "in" parsing', () => {
  test('"in" inside a quoted value is part of the query', async () => {
    const seen: string[][] = [];
    await new AnvesaVerifier(runner(queryMiss, seen)).verify(
      'r',
      claim('wql', '//function[@name="sign in user"]'),
    );
    expect(seen[0]?.[1]).toBe('//function[@name="sign in user"]');
    expect(seen[0]?.[3]).toBe('1');
  });
});

describe('TextVerifier', () => {
  const root = mkdtempSync(join(tmpdir(), 'yojana-text-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'tooling'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'tooling', 'platforms.ts'),
    "export const P = [\n  'linux-x64',\n  'darwin-arm64',\n];\n",
  );
  writeFileSync(join(root, 'src', 'a.ts'), 'const a = 1;\nconsole.log(a);\n');
  writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 2;\n');

  const verify = (expression: string, expectValue = true) =>
    new TextVerifier(root).verify('r', claim('text', expression, expectValue));

  test('a missing string in a named file is violated, with how much was searched', async () => {
    expect(await verify('darwin-x64 in tooling/platforms.ts')).toMatchObject({
      outcome: 'violated',
      evidence: 'not found (1 file searched)',
    });
    expect(await verify('darwin-arm64 in tooling/platforms.ts')).toMatchObject({
      outcome: 'holds',
      evidence: 'found at tooling/platforms.ts:3 (1 line, 1 file searched)',
    });
  });

  test('a /regex/ over a glob, with expect: false', async () => {
    expect(await verify(String.raw`/console\.log\(/ in src/**/*.ts`, false)).toMatchObject({
      outcome: 'violated',
      evidence: 'found at src/a.ts:2 (1 line, 2 files searched)',
    });
    expect((await verify('/DEBUGGER/i in src/**/*.ts', false)).outcome).toBe('holds');
  });

  test('no file to search, a bad pattern, or a malformed expression is unverifiable', async () => {
    expect(await verify('x in nowhere/**/*.ts', false)).toMatchObject({
      outcome: 'unverifiable',
      evidence: 'no file matches nowhere/**/*.ts',
    });
    expect((await verify('/(unclosed/ in src/a.ts')).outcome).toBe('unverifiable');
    expect((await verify('just a pattern')).outcome).toBe('unverifiable');
  });
});
