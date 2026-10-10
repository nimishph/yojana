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

describe('AnvesaVerifier: namespaced kinds (anvesa.wql, anvesa.dependents)', () => {
  test('anvesa.wql runs syntactic query', async () => {
    const seen: string[][] = [];
    const result = await new AnvesaVerifier(runner(queryHit, seen)).verify(
      'r',
      claim('anvesa.wql', '//class[@name="CommandFailedError"]'),
    );
    expect(result).toMatchObject({ outcome: 'holds', evidence: 'matches cli/src/errors.ts:8' });
    expect(seen[0]).toEqual(['query', '//class[@name="CommandFailedError"]', '--limit', '1']);
  });

  test('anvesa.dependents runs dependency query', async () => {
    const seen: string[][] = [];
    const result = await new AnvesaVerifier(runner(dependents, seen)).verify(
      'r',
      claim('anvesa.dependents', 'core/src/index.ts'),
    );
    expect(result).toMatchObject({ outcome: 'holds' });
    expect(seen[0]?.slice(0, 2)).toEqual(['dependents', 'core/src/index.ts']);
  });
});

describe('AnvesaVerifier: callers', () => {
  const callersHit = {
    symbol: { id: 's1', name: 'validate', path: 'src/config.ts', line: 10 },
    callers: {
      items: [
        { from: 'src/server.ts#startServer', path: 'src/server.ts', line: 42 },
        { from: 'src/cli.ts#main', path: 'src/cli.ts', line: 15 },
      ],
      total: 2,
    },
  };

  const callersEmpty = {
    symbol: { id: 's2', name: 'unusedHelper', path: 'src/dead.ts', line: 5 },
    callers: {
      items: [],
      total: 0,
    },
  };

  test('dead code check: count == 0 holds when unused, violated when called', async () => {
    const emptyVerifier = new AnvesaVerifier(runner(callersEmpty));
    const deadClaim: Claim = {
      kind: 'anvesa.callers',
      params: { symbol: 'unusedHelper' },
      expect: { count: { eq: 0 } },
    };
    const emptyRes = await emptyVerifier.verify('r', deadClaim);
    expect(emptyRes.outcome).toBe('holds');
    expect(emptyRes.evidence).toBe('no callers for unusedHelper');

    const hitVerifier = new AnvesaVerifier(runner(callersHit));
    const hitRes = await hitVerifier.verify('r', deadClaim);
    expect(hitRes.outcome).toBe('violated');
    expect(hitRes.evidence).toContain(
      'called by src/server.ts#startServer, src/cli.ts#main (2 callers)',
    );
  });

  test('resolvedOnly option passes --resolved-only flag', async () => {
    const seen: string[][] = [];
    const verifier = new AnvesaVerifier(runner(callersHit, seen));
    const claimWithResolved: Claim = {
      kind: 'anvesa.callers',
      params: { symbol: 'validate', resolvedOnly: true },
      expect: { count: { gte: 1 } },
    };
    const res = await verifier.verify('r', claimWithResolved);
    expect(res.outcome).toBe('holds');
    expect(seen[0]).toContain('--resolved-only');
  });
});

describe('AnvesaVerifier: callees', () => {
  const calleesHit = {
    symbol: { id: 's1', name: 'startServer', path: 'src/server.ts', line: 42 },
    callees: {
      items: [{ to: 'src/config.ts#validate', path: 'src/config.ts', line: 10 }],
      total: 1,
    },
  };

  test('counts callees with predicate', async () => {
    const seen: string[][] = [];
    const verifier = new AnvesaVerifier(runner(calleesHit, seen));
    const claimCallees: Claim = {
      kind: 'anvesa.callees',
      params: { symbol: 'startServer' },
      expect: { count: { eq: 1 } },
    };
    const res = await verifier.verify('r', claimCallees);
    expect(res.outcome).toBe('holds');
    expect(res.evidence).toBe('calls src/config.ts#validate (1 callee)');
    expect(seen[0]?.slice(0, 2)).toEqual(['callees', 'startServer']);
  });
});

describe('AnvesaVerifier: routes', () => {
  const routesData = [
    {
      id: 'r1',
      path: 'src/server.ts',
      method: 'GET',
      route: '/api/users',
      handler: 'listUsers',
      line: 20,
      framework: 'express',
    },
    {
      id: 'r2',
      path: 'src/server.ts',
      method: 'POST',
      route: '/api/users',
      handler: 'createUser',
      line: 30,
      framework: 'express',
    },
  ];

  test('measures discovered endpoint routes and evaluates count predicates', async () => {
    const seen: string[][] = [];
    const verifier = new AnvesaVerifier(runner(routesData, seen));
    const claimRoutes: Claim = {
      kind: 'anvesa.routes',
      params: { method: 'GET', path: '/api/users', framework: 'express' },
      expect: { count: { gte: 1 } },
    };
    const res = await verifier.verify('r', claimRoutes);
    expect(res.outcome).toBe('holds');
    expect(res.evidence).toContain('GET /api/users');
    expect(seen[0]).toEqual(['routes', 'GET', '/api/users', '--framework', 'express']);
  });

  test('shorthand expression parses method and path', async () => {
    const seen: string[][] = [];
    const verifier = new AnvesaVerifier(runner(routesData, seen));
    const claimExpr: Claim = {
      kind: 'anvesa.routes',
      expression: 'POST /api/users',
      expect: true,
    };
    const res = await verifier.verify('r', claimExpr);
    expect(res.outcome).toBe('holds');
    expect(seen[0]).toEqual(['routes', 'POST', '/api/users']);
  });
});

describe('AnvesaVerifier: describe and indexState', () => {
  test('describe returns all supported kinds with schemas', () => {
    const verifier = new AnvesaVerifier(runner({}));
    const desc = verifier.describe();
    expect(desc.name).toBe('anvesa');
    expect(desc.kinds.map((k) => k.kind)).toEqual([
      'anvesa.wql',
      'wql',
      'anvesa.dependents',
      'dependents',
      'anvesa.callers',
      'anvesa.callees',
      'anvesa.routes',
    ]);
    expect(desc.kinds.every((k) => k.deterministic)).toBe(true);
  });

  test('indexState queries status', async () => {
    const statusData = {
      root: '/repo',
      indexed: true,
      index: { symbols: 120, calls: 450, files: 25 },
    };
    const verifier = new AnvesaVerifier(runner(statusData));
    expect(await verifier.indexState()).toBe('120:450:25');

    const failingVerifier = new AnvesaVerifier(async () => {
      throw new YojanaError('TEST_FAIL', 'fail');
    });
    expect(await failingVerifier.indexState()).toBeUndefined();
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
