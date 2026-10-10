import { describe, expect, test } from 'bun:test';
import { type Claim, YojanaError } from '@cntxt-labs/yojana-core';
import { ExternalVerifier, type StdioAction, type StdioRunner } from '../external.ts';

function mockStdioRunner(
  handlers: Partial<
    Record<
      StdioAction,
      (payload: Record<string, unknown>) => { exitCode: number; stdout: string; stderr: string }
    >
  >,
  recorded: { action: StdioAction; payload: Record<string, unknown> }[] = [],
): StdioRunner {
  return async (action, payload) => {
    recorded.push({ action, payload });
    const handler = handlers[action];
    if (handler) {
      return handler(payload);
    }
    return { exitCode: 0, stdout: '{}', stderr: '' };
  };
}

describe('ExternalVerifier', () => {
  const descriptorData = {
    name: 'custom-check',
    version: '1.2.0',
    kinds: [
      {
        kind: 'custom.linter',
        description: 'Custom lint checks',
        expression: true,
        params: {
          path: { type: 'string', required: true },
          maxWarnings: { type: 'number', required: false },
        },
        deterministic: true,
      },
    ],
  };

  test('describe runs stdio describe action and populates kinds', async () => {
    const recorded: { action: StdioAction; payload: Record<string, unknown> }[] = [];
    const runner = mockStdioRunner(
      {
        describe: () => ({
          exitCode: 0,
          stdout: JSON.stringify(descriptorData),
          stderr: '',
        }),
      },
      recorded,
    );

    const verifier = new ExternalVerifier({ name: 'custom-check', command: './bin/check' }, runner);
    expect(verifier.kinds).toEqual([]);

    const desc = await verifier.describe();
    expect(desc.name).toBe('custom-check');
    expect(desc.kinds).toHaveLength(1);
    expect(desc.kinds[0]?.kind).toBe('custom.linter');
    expect(verifier.kinds).toEqual(['custom.linter']);
    expect(recorded[0]?.action).toBe('describe');
  });

  test('constructor with explicit kinds retains them immediately', () => {
    const verifier = new ExternalVerifier(
      { name: 'custom-check', command: './bin/check', kinds: ['predeclared.kind'] },
      mockStdioRunner({}),
    );
    expect(verifier.kinds).toEqual(['predeclared.kind']);
  });

  test('verify runs stdio verify action and evaluates measurements predicate', async () => {
    const recorded: { action: StdioAction; payload: Record<string, unknown> }[] = [];
    const runner = mockStdioRunner(
      {
        verify: () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            evidence: 'found 0 warnings',
            measurements: { count: 0, warnings: 0 },
          }),
          stderr: '',
        }),
      },
      recorded,
    );

    const verifier = new ExternalVerifier({ name: 'custom-check', command: './bin/check' }, runner);
    const claim: Claim = {
      kind: 'custom.linter',
      params: { path: 'src/main.ts' },
      expect: { count: { eq: 0 } },
    };

    const result = await verifier.verify('req-1', claim);
    expect(result.outcome).toBe('holds');
    expect(result.evidence).toBe('found 0 warnings');
    expect(result.measurements).toEqual({ count: 0, warnings: 0 });
    expect(recorded[0]?.action).toBe('verify');
    expect(recorded[0]?.payload.requirement).toBe('req-1');
  });

  test('verify evaluates violated outcome when measurements do not satisfy expectation', async () => {
    const runner = mockStdioRunner({
      verify: () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          evidence: 'found 5 errors',
          measurements: { count: 5 },
        }),
        stderr: '',
      }),
    });

    const verifier = new ExternalVerifier({ name: 'custom-check', command: './bin/check' }, runner);
    const claim: Claim = {
      kind: 'custom.linter',
      params: { path: 'src/main.ts' },
      expect: { count: { eq: 0 } },
    };

    const result = await verifier.verify('req-1', claim);
    expect(result.outcome).toBe('violated');
    expect(result.evidence).toBe('found 5 errors');
  });

  test('indexState queries external adapter', async () => {
    const runner = mockStdioRunner({
      indexState: () => ({
        exitCode: 0,
        stdout: JSON.stringify({ indexState: 'git-commit-hash-abc' }),
        stderr: '',
      }),
    });

    const verifier = new ExternalVerifier({ name: 'custom-check', command: './bin/check' }, runner);
    expect(await verifier.indexState()).toBe('git-commit-hash-abc');
  });

  test('non-zero exit code or malformed JSON produces unverifiable', async () => {
    const failingRunner = mockStdioRunner({
      verify: () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'fatal: tool crashed',
      }),
    });

    const verifier = new ExternalVerifier(
      { name: 'custom-check', command: './bin/check' },
      failingRunner,
    );
    const claim: Claim = { kind: 'custom.linter', expect: true };
    const result = await verifier.verify('req-1', claim);
    expect(result.outcome).toBe('unverifiable');
    expect(result.evidence).toContain('fatal: tool crashed');

    const malformedRunner = mockStdioRunner({
      verify: () => ({
        exitCode: 0,
        stdout: 'not json',
        stderr: '',
      }),
    });
    const verifier2 = new ExternalVerifier(
      { name: 'custom-check', command: './bin/check' },
      malformedRunner,
    );
    const result2 = await verifier2.verify('req-1', claim);
    expect(result2.outcome).toBe('unverifiable');
    expect(result2.evidence).toContain('did not answer in JSON');

    const spawnThrowRunner: StdioRunner = async () => {
      throw new YojanaError('TEST_FAIL', 'executable not found');
    };
    const verifier3 = new ExternalVerifier(
      { name: 'custom-check', command: './bin/check' },
      spawnThrowRunner,
    );
    const result3 = await verifier3.verify('req-1', claim);
    expect(result3.outcome).toBe('unverifiable');
    expect(result3.evidence).toContain('could not run external verifier');
  });
});
