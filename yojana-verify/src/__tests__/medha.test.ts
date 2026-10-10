import { describe, expect, test } from 'bun:test';
import { type Claim, YojanaError } from '@cntxt-labs/yojana-core';
import { type MedhaRunner, MedhaVerifier, parseEntityKey } from '../medha.ts';

function mockMedhaRunner(output: unknown, seen: string[][] = []): MedhaRunner {
  return async (args) => {
    seen.push([...args]);
    return { exitCode: 0, stdout: JSON.stringify(output), stderr: '' };
  };
}

describe('parseEntityKey', () => {
  test('parses kind/id from entity or shorthand expression', () => {
    expect(parseEntityKey('rule/auth-guard')).toEqual({
      kind: 'rule',
      id: 'auth-guard',
      namespace: undefined,
    });
    expect(parseEntityKey('recipe/deploy')).toEqual({
      kind: 'recipe',
      id: 'deploy',
      namespace: undefined,
    });
    expect(parseEntityKey('just-name')).toEqual({
      kind: 'rule',
      id: 'just-name',
      namespace: undefined,
    });
    expect(parseEntityKey(undefined, { entity: 'tool/lint', namespace: 'core' })).toEqual({
      kind: 'tool',
      id: 'lint',
      namespace: 'core',
    });
  });
});

describe('MedhaVerifier', () => {
  const trustedEntityReport = {
    asOf: 1728470000000,
    detail: {
      hint: {
        status: 'trusted',
        trustScore: 0.85,
        temporal: {
          isDrifting: false,
          driftDelta: 0.02,
          driftDirection: 'up',
        },
      },
      known: true,
    },
  };

  const probationEntityReport = {
    asOf: 1728470000000,
    detail: {
      hint: {
        status: 'probation',
        trustScore: 0.45,
        temporal: {
          isDrifting: true,
          driftDelta: 0.25,
          driftDirection: 'down',
        },
      },
      known: true,
    },
  };

  test('describe returns medha.entity descriptor with deterministic: false', () => {
    const verifier = new MedhaVerifier(mockMedhaRunner({}));
    const desc = verifier.describe();
    expect(desc.name).toBe('medha');
    expect(desc.kinds).toHaveLength(1);
    expect(desc.kinds[0]?.kind).toBe('medha.entity');
    expect(desc.kinds[0]?.deterministic).toBe(false);
  });

  test('claim: rule is adopted and proven (status in [trusted, active], trust >= 0.7)', async () => {
    const seen: string[][] = [];
    const verifier = new MedhaVerifier(mockMedhaRunner(trustedEntityReport, seen));
    const claim: Claim = {
      kind: 'medha.entity',
      params: { entity: 'rule/auth-check' },
      expect: {
        status: { in: ['trusted', 'active'] },
        trust: { gte: 0.7 },
      },
    };

    const result = await verifier.verify('req-1', claim);
    expect(result.outcome).toBe('holds');
    expect(result.deterministic).toBe(false);
    expect(result.measuredAt).toBe(1728470000000);
    expect(result.evidence).toContain('rule/auth-check status is trusted, trust is 0.85');
    expect(seen[0]).toEqual(['show', '--id', 'auth-check', '--kind', 'rule']);
  });

  test('low trust or probation status violates the expectation', async () => {
    const verifier = new MedhaVerifier(mockMedhaRunner(probationEntityReport));
    const claim: Claim = {
      kind: 'medha.entity',
      params: { entity: 'rule/auth-check' },
      expect: {
        status: { in: ['trusted', 'active'] },
        trust: { gte: 0.7 },
      },
    };

    const result = await verifier.verify('req-1', claim);
    expect(result.outcome).toBe('violated');
    expect(result.evidence).toContain(
      'rule/auth-check status is probation, trust is 0.45, drifting (down)',
    );
  });

  test('checks drift expectation', async () => {
    const verifier = new MedhaVerifier(mockMedhaRunner(probationEntityReport));
    const noDriftClaim: Claim = {
      kind: 'medha.entity',
      params: { entity: 'rule/auth-check' },
      expect: {
        drift: false,
      },
    };

    const result = await verifier.verify('req-1', noDriftClaim);
    expect(result.outcome).toBe('violated');
  });

  test('namespace is passed to medha CLI arguments', async () => {
    const seen: string[][] = [];
    const verifier = new MedhaVerifier(mockMedhaRunner(trustedEntityReport, seen));
    const claim: Claim = {
      kind: 'medha.entity',
      params: { entity: 'tool/compiler', namespace: 'proj-x' },
      expect: true,
    };

    const result = await verifier.verify('req-1', claim);
    expect(result.outcome).toBe('holds');
    expect(seen[0]).toEqual([
      'show',
      '--id',
      'compiler',
      '--kind',
      'tool',
      '--namespace',
      'proj-x',
    ]);
  });

  test('handles unknown entity with probation prior', async () => {
    const unknownReport = {
      asOf: 1728470000000,
      detail: {
        hint: {
          status: 'probation',
          trustScore: 0.5,
          temporal: { isDrifting: false, driftDelta: 0 },
        },
        known: false,
      },
    };

    const verifier = new MedhaVerifier(mockMedhaRunner(unknownReport));
    const claim: Claim = {
      kind: 'medha.entity',
      expression: 'rule/new-rule',
      expect: true,
    };

    const result = await verifier.verify('req-1', claim);
    expect(result.outcome).toBe('violated');
    expect(result.evidence).toContain('unknown entity, probation prior');
  });

  test('reports unverifiable when medha fails or errors', async () => {
    const failingRunner: MedhaRunner = async () => {
      throw new YojanaError('TEST_MEDHA', 'medha binary not found');
    };
    const verifier = new MedhaVerifier(failingRunner);
    const result = await verifier.verify('req-1', {
      kind: 'medha.entity',
      expression: 'rule/x',
      expect: true,
    });
    expect(result.outcome).toBe('unverifiable');
    expect(result.evidence).toContain('could not run medha');

    const errorRunner = mockMedhaRunner({
      error: { code: 'CORE_NOT_FOUND', message: 'entity not found' },
    });
    const errorRes = await new MedhaVerifier(errorRunner).verify('req-1', {
      kind: 'medha.entity',
      expression: 'rule/x',
      expect: true,
    });
    expect(errorRes.outcome).toBe('unverifiable');
    expect(errorRes.evidence).toBe('CORE_NOT_FOUND: entity not found');
  });
});

describe('MedhaRuleSink', () => {
  test('proposes rules via medha propose with correct CLI arguments', async () => {
    const { MedhaRuleSink } = await import('../medha.ts');
    const seenArgs: string[][] = [];
    const runner: MedhaRunner = async (args) => {
      seenArgs.push([...args]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          entity: { id: args[args.indexOf('--id') + 1], status: 'probation' },
        }),
        stderr: '',
      };
    };

    const sink = new MedhaRuleSink(runner, { namespace: 'core' });
    const results = await sink.propose([
      {
        id: 'rule-auth',
        kind: 'rule',
        source: 'plan/auth',
        text: 'All endpoints require JWT token validation',
        evidence: 'claim path src/jwt.ts holds',
        author: 'nimish',
        note: 'Realized in plan/auth',
      },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('rule-auth');
    expect(results[0]?.ok).toBe(true);

    expect(seenArgs).toHaveLength(1);
    const args = seenArgs[0] ?? [];
    expect(args).toContain('propose');
    expect(args).toContain('--kind');
    expect(args).toContain('rule');
    expect(args).toContain('--id');
    expect(args).toContain('rule-auth');
    expect(args).toContain('--namespace');
    expect(args).toContain('core');
    expect(args).toContain('--source');
    expect(args).toContain('plan/auth');
    expect(args).toContain('--text');
    expect(args).toContain('All endpoints require JWT token validation');
    expect(args).toContain('--evidence');
    expect(args).toContain('claim path src/jwt.ts holds');
    expect(args).toContain('--author');
    expect(args).toContain('nimish');
    expect(args).toContain('--note');
    expect(args).toContain('Realized in plan/auth');
  });

  test('handles medha propose error exit', async () => {
    const { MedhaRuleSink } = await import('../medha.ts');
    const runner: MedhaRunner = async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'entity already exists',
    });

    const sink = new MedhaRuleSink(runner);
    const results = await sink.propose([
      {
        id: 'dup-rule',
        source: 'plan/test',
      },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('dup-rule');
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toContain('entity already exists');
  });
});
