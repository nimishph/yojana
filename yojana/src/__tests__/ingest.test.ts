import { describe, expect, test } from 'bun:test';
import { foldLog, planHeads, type VerifierPort, YojanaError } from '@cntxt-labs/yojana-core';
import { MarkdownParser } from '@cntxt-labs/yojana-markdown';
import { MemoryBaseStore, MemoryStore } from '@cntxt-labs/yojana-store';
import { type FileReport, ingest, movement } from '../ingest.ts';

const parser = new MarkdownParser();

function planText(requirements: Record<string, string>, status = 'draft'): string {
  const body = Object.entries(requirements)
    .map(([id, text]) => `## Requirement: ${id} {#${id}}\n\n${text}`)
    .join('\n\n');
  return `---\nid: plan/p\nstatus: ${status}\n---\n\n${body}\n`;
}

async function setup() {
  const store = new MemoryStore();
  await store.open();
  const bases = new MemoryBaseStore();
  const run = async (text: string, extra?: { trustFile?: boolean; actor?: string }) => {
    const report = await ingest({
      store,
      parser,
      bases,
      files: [{ source: 'plans/p.md', text }],
      actor: extra?.actor ?? 'me',
      trustFile: extra?.trustFile,
    });
    return report.files[0] as FileReport;
  };
  const heads = async () => planHeads(foldLog(await store.events()), 'plan/p');
  return { store, bases, run, heads };
}

describe('movement', () => {
  test('the four cases', () => {
    expect(movement('x', 'a', 'x')).toBe('same');
    expect(movement('x', 'a', 'a')).toBe('edited');
    expect(movement('a', 'a', 'y')).toBe('behind');
    expect(movement('x', 'a', 'y')).toBe('conflict');
  });
});

describe('ingest', () => {
  test('a new plan records its status and every requirement', async () => {
    const { run, store } = await setup();
    const report = await run(planText({ a: 'one', b: 'two' }, 'accepted'));
    expect(report.outcome).toBe('recorded');
    expect(report.requirements.map((r) => [r.id, r.action])).toEqual([
      ['a', 'added'],
      ['b', 'added'],
    ]);
    const events = await store.events();
    expect(events.map((e) => e.type)).toEqual([
      'status-changed',
      'revision-recorded',
      'revision-recorded',
    ]);
    expect(events[0]).toMatchObject({ to: 'accepted', reason: 'created from plans/p.md' });
  });

  test('running again with no edits appends nothing', async () => {
    const { run, store } = await setup();
    await run(planText({ a: 'one' }));
    const before = await store.head();
    const report = await run(planText({ a: 'one' }));
    expect(report).toMatchObject({ outcome: 'unchanged', appended: 0, requirements: [] });
    expect(await store.head()).toBe(before);
  });

  test('editing one requirement records exactly one event, on the log revision', async () => {
    const { run, store, heads } = await setup();
    await run(planText({ a: 'one', b: 'two' }));
    const oldA = (await heads()).get('a');
    const report = await run(planText({ a: 'one, edited', b: 'two' }));
    expect(report.appended).toBe(1);
    const last = (await store.events()).at(-1);
    expect(last).toMatchObject({ type: 'revision-recorded', base: oldA, actor: 'me' });
    expect((await heads()).get('a')).not.toBe(oldA);
  });

  test('deleting a requirement from the file removes it from the log', async () => {
    const { run, heads } = await setup();
    await run(planText({ a: 'one', b: 'two' }));
    const report = await run(planText({ a: 'one' }));
    expect(report.requirements).toMatchObject([{ id: 'b', action: 'removed' }]);
    expect([...(await heads()).keys()]).toEqual(['a']);
  });

  test('a status edit is recorded with the file as its reason', async () => {
    const { run, store } = await setup();
    await run(planText({ a: 'one' }));
    await run(planText({ a: 'one' }, 'in-progress'));
    const last = (await store.events()).at(-1);
    expect(last).toMatchObject({ to: 'in-progress', reason: 'edited in plans/p.md' });
  });

  describe('when the log moves without the file', () => {
    /** Simulate another writer (an archive, another machine) changing requirement a. */
    async function moveLog(ctx: Awaited<ReturnType<typeof setup>>, text: string) {
      const logA = (await ctx.heads()).get('a');
      const parsed = parser.parse('elsewhere', planText({ a: text }));
      if (!parsed.ok) throw new YojanaError('TEST_FIXTURE', 'fixture does not parse');
      const requirement = parsed.plan.requirements[0];
      if (requirement === undefined)
        throw new YojanaError('TEST_FIXTURE', 'fixture has no requirement');
      await ctx.store.append(
        { type: 'revision-recorded', planId: 'plan/p', requirement, base: logA },
        'other',
      );
    }

    test('an untouched file is reported behind and nothing is recorded', async () => {
      const ctx = await setup();
      await ctx.run(planText({ a: 'one', b: 'two' }));
      await moveLog(ctx, 'changed elsewhere');
      const before = await ctx.store.head();
      const report = await ctx.run(planText({ a: 'one', b: 'two' }));
      expect(report.outcome).toBe('unchanged');
      expect(report.requirements).toMatchObject([{ id: 'a', movement: 'behind' }]);
      expect(await ctx.store.head()).toBe(before);
    });

    test('a file edit on the stale base is refused with all three revisions', async () => {
      const ctx = await setup();
      await ctx.run(planText({ a: 'one', b: 'two' }));
      const base = (await ctx.heads()).get('a');
      await moveLog(ctx, 'changed elsewhere');
      const logNow = (await ctx.heads()).get('a');
      const before = await ctx.store.head();

      const report = await ctx.run(planText({ a: 'my edit', b: 'two, also edited' }));
      expect(report.outcome).toBe('refused');
      const a = report.requirements.find((r) => r.id === 'a');
      expect(a).toMatchObject({ movement: 'conflict', base, log: logNow });
      expect(a?.file).not.toBe(base);
      // All or nothing: the clean edit to b is not recorded either.
      expect(await ctx.store.head()).toBe(before);
    });

    test('a behind file can still record edits to other requirements', async () => {
      const ctx = await setup();
      await ctx.run(planText({ a: 'one', b: 'two' }));
      await moveLog(ctx, 'changed elsewhere');
      const report = await ctx.run(planText({ a: 'one', b: 'two, edited' }));
      expect(report.outcome).toBe('recorded');
      expect(report.requirements.map((r) => [r.id, r.movement])).toEqual([
        ['a', 'behind'],
        ['b', 'edited'],
      ]);
      // The base keeps a behind requirement where it was, so it stays behind, not edited.
      const again = await ctx.run(planText({ a: 'one', b: 'two, edited' }));
      expect(again.requirements.map((r) => [r.id, r.movement])).toEqual([['a', 'behind']]);
    });
  });

  test('a lost base refuses differing requirements unless the file is trusted', async () => {
    const store = new MemoryStore();
    await store.open();
    const options = (bases: MemoryBaseStore, text: string, trustFile?: boolean) => ({
      store,
      parser,
      bases,
      files: [{ source: 'plans/p.md', text }],
      actor: 'me',
      trustFile,
    });
    await ingest(options(new MemoryBaseStore(), planText({ a: 'one' })));

    const lost = await ingest(options(new MemoryBaseStore(), planText({ a: 'edited' })));
    expect(lost.files[0]).toMatchObject({ outcome: 'refused', missingBase: true });

    const trusted = await ingest(options(new MemoryBaseStore(), planText({ a: 'edited' }), true));
    expect(trusted.files[0]).toMatchObject({ outcome: 'recorded', missingBase: true, appended: 1 });
  });

  test('invalid files and duplicate plan ids are reported, not ingested', async () => {
    const store = new MemoryStore();
    await store.open();
    const report = await ingest({
      store,
      parser,
      bases: new MemoryBaseStore(),
      files: [
        { source: 'bad.md', text: 'no frontmatter' },
        { source: 'one.md', text: planText({ a: 'x' }) },
        { source: 'two.md', text: planText({ a: 'y' }) },
      ],
      actor: 'me',
    });
    expect(report.files.map((f) => [f.source, f.outcome])).toEqual([
      ['bad.md', 'invalid'],
      ['one.md', 'recorded'],
      ['two.md', 'invalid'],
    ]);
    expect(report.files[2]?.issues[0]?.code).toBe('DUPLICATE_PLAN');
  });
});

describe('ingest after a merge where both branches edited one requirement', () => {
  test('the plan file settles the contested requirement, even when it matches one side', async () => {
    const ctx = await setup();
    await ctx.run(planText({ a: 'one', b: 'two' }));
    const start = (await ctx.heads()).get('a');
    // The other branch's edit, merged into the log on top of the same starting revision.
    const recordOn = async (text: string) => {
      const parsed = parser.parse('elsewhere', planText({ a: text }));
      if (!parsed.ok || parsed.plan.requirements[0] === undefined) {
        throw new YojanaError('TEST_FIXTURE', 'does not parse');
      }
      await ctx.store.append(
        {
          type: 'revision-recorded',
          planId: 'plan/p',
          requirement: parsed.plan.requirements[0],
          base: start,
        },
        'other',
      );
    };
    await recordOn('ours');
    await recordOn('theirs');
    expect(
      foldLog(await ctx.store.events())
        .plans.get('plan/p')
        ?.contested.has('a'),
    ).toBe(true);

    // The person resolved git's conflict in the plan file by keeping "theirs".
    const report = await ctx.run(planText({ a: 'theirs', b: 'two' }));
    expect(report.outcome).toBe('recorded');
    expect(report.requirements).toMatchObject([{ id: 'a', movement: 'resolved' }]);
    const state = foldLog(await ctx.store.events());
    expect(state.plans.get('plan/p')?.contested.size).toBe(0);

    const again = await ctx.run(planText({ a: 'theirs', b: 'two' }));
    expect(again).toMatchObject({ outcome: 'unchanged', requirements: [] });
  });
});

describe('ingest with verifier schema validation', () => {
  const verifier: VerifierPort = {
    name: 'test-adapter',
    kinds: ['path', 'anvesa/routes'],
    describe: () => ({
      name: 'test-adapter',
      version: '1.0.0',
      kinds: [
        {
          kind: 'path',
          expression: true,
          deterministic: true,
        },
        {
          kind: 'anvesa/routes',
          expression: false,
          params: {
            path: { type: 'string', required: true },
            methods: { type: 'array', required: false },
          },
          deterministic: true,
        },
      ],
    }),
    verify: async (req, claim) => ({
      requirement: req,
      claim,
      outcome: 'holds',
      evidence: 'ok',
    }),
  };

  test('a typo in claim kind fails at ingest with UNKNOWN_CLAIM_KIND', async () => {
    const store = new MemoryStore();
    await store.open();
    const badKindPlan = `---
id: plan/typo
---

## Requirement: typo {#r1}

\`\`\`yojana:claim
kind: pth
expression: src/index.ts
\`\`\`
`;
    const report = await ingest({
      store,
      parser,
      bases: new MemoryBaseStore(),
      files: [{ source: 'plans/typo.md', text: badKindPlan }],
      actor: 'me',
      verifiers: [verifier],
    });
    expect(report.files[0]?.outcome).toBe('invalid');
    expect(report.files[0]?.issues[0]?.code).toBe('UNKNOWN_CLAIM_KIND');
    expect(report.files[0]?.issues[0]?.message).toContain('pth');
  });

  test('a shorthand expression when unsupported fails with INVALID_CLAIM', async () => {
    const store = new MemoryStore();
    await store.open();
    const badExprPlan = `---
id: plan/bad-expr
---

## Requirement: bad expr {#r1}

\`\`\`yojana:claim
kind: anvesa/routes
expression: /api/v1
\`\`\`
`;
    const report = await ingest({
      store,
      parser,
      bases: new MemoryBaseStore(),
      files: [{ source: 'plans/bad-expr.md', text: badExprPlan }],
      actor: 'me',
      verifiers: [verifier],
    });
    expect(report.files[0]?.outcome).toBe('invalid');
    expect(report.files[0]?.issues[0]?.code).toBe('INVALID_CLAIM');
  });

  test('missing required param or invalid param type fails with schema issues', async () => {
    const store = new MemoryStore();
    await store.open();
    const badParamPlan = `---
id: plan/bad-param
---

## Requirement: bad param {#r1}

\`\`\`yojana:claim
kind: anvesa/routes
methods: "not-an-array"
\`\`\`
`;
    const report = await ingest({
      store,
      parser,
      bases: new MemoryBaseStore(),
      files: [{ source: 'plans/bad-param.md', text: badParamPlan }],
      actor: 'me',
      verifiers: [verifier],
    });
    expect(report.files[0]?.outcome).toBe('invalid');
    const codes = report.files[0]?.issues.map((i) => i.code);
    expect(codes).toContain('MISSING_CLAIM_PARAM');
    expect(codes).toContain('INVALID_CLAIM_PARAM');
  });

  test('unknown param fails with UNKNOWN_CLAIM_PARAM', async () => {
    const store = new MemoryStore();
    await store.open();
    const unknownParamPlan = `---
id: plan/unknown-param
---

## Requirement: unknown param {#r1}

\`\`\`yojana:claim
kind: anvesa/routes
path: /api/v1
bogus: true
\`\`\`
`;
    const report = await ingest({
      store,
      parser,
      bases: new MemoryBaseStore(),
      files: [{ source: 'plans/unknown-param.md', text: unknownParamPlan }],
      actor: 'me',
      verifiers: [verifier],
    });
    expect(report.files[0]?.outcome).toBe('invalid');
    expect(report.files[0]?.issues[0]?.code).toBe('UNKNOWN_CLAIM_PARAM');
  });

  test('valid claims pass ingest and record', async () => {
    const store = new MemoryStore();
    await store.open();
    const validPlan = `---
id: plan/valid
---

## Requirement: valid {#r1}

\`\`\`yojana:claim
kind: anvesa/routes
path: /api/v1
methods:
  - GET
\`\`\`
`;
    const report = await ingest({
      store,
      parser,
      bases: new MemoryBaseStore(),
      files: [{ source: 'plans/valid.md', text: validPlan }],
      actor: 'me',
      verifiers: [verifier],
    });
    expect(report.files[0]?.outcome).toBe('recorded');
    expect(report.files[0]?.issues).toEqual([]);
  });

  test('valid composite claims pass ingest and record', async () => {
    const store = new MemoryStore();
    await store.open();
    const compositePlan = `---
id: plan/valid-composite
---

## Requirement: valid composite {#r1}

\`\`\`yojana:claim
kind: all
claims:
  - kind: anvesa/routes
    path: /api/v1
    methods:
      - GET
  - kind: not
    claim:
      kind: anvesa/routes
      path: /api/v2
      methods:
        - POST
\`\`\`
`;
    const report = await ingest({
      store,
      parser,
      bases: new MemoryBaseStore(),
      files: [{ source: 'plans/composite.md', text: compositePlan }],
      actor: 'me',
      verifiers: [verifier],
    });
    expect(report.files[0]?.outcome).toBe('recorded');
    expect(report.files[0]?.issues).toEqual([]);
  });

  test('composite claim with unknown child kind fails ingest', async () => {
    const store = new MemoryStore();
    await store.open();
    const badPlan = `---
id: plan/bad-composite
---

## Requirement: bad composite {#r1}

\`\`\`yojana:claim
kind: all
claims:
  - kind: anvesa/routes
    path: /api/v1
    methods:
      - GET
  - kind: mystery/nonexistent
    expression: foo
\`\`\`
`;
    const report = await ingest({
      store,
      parser,
      bases: new MemoryBaseStore(),
      files: [{ source: 'plans/bad.md', text: badPlan }],
      actor: 'me',
      verifiers: [verifier],
    });
    expect(report.files[0]?.outcome).toBe('invalid');
    expect(report.files[0]?.issues[0]?.code).toBe('UNKNOWN_CLAIM_KIND');
    expect(report.files[0]?.issues[0]?.message).toContain('mystery/nonexistent');
  });
});
