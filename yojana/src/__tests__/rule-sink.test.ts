import { describe, expect, test } from 'bun:test';
import type {
  RuleProposal,
  RuleProposalResult,
  RuleSinkPort,
  WorkLinkPort,
} from '@cntxt-labs/yojana-core';
import { MarkdownParser } from '@cntxt-labs/yojana-markdown';
import { MemoryBaseStore, MemoryStore } from '@cntxt-labs/yojana-store';
import type { CheckReport } from '../check.ts';
import { ingest } from '../ingest.ts';
import { proposeRules } from '../rule-sink.ts';

const PLAN_REALIZED = `---
id: plan/realized-feature
status: realized
---

## Requirement: verified architecture {#req-arch}

The architecture avoids global singletons.

\`\`\`yojana:claim
kind: path
expression: src/core.ts
\`\`\`

### Actions

- Implement factory {#act-factory bead=feat-1}

\`\`\`yojana:claim
kind: path
expression: src/factory.ts
\`\`\`

## Requirement: empty requirement {#req-empty}

No claims here.

## Requirement: broken check {#req-broken}

\`\`\`yojana:claim
kind: path
expression: src/missing.ts
\`\`\`
`;

const PLAN_IN_PROGRESS = `---
id: plan/wip-feature
status: in-progress
---

## Requirement: completed item {#req-done beads=item-done}

Work is finished and verified.

\`\`\`yojana:claim
kind: path
expression: src/done.ts
\`\`\`

## Requirement: incomplete item {#req-open beads=item-open}

Work is still ongoing.

\`\`\`yojana:claim
kind: path
expression: src/wip.ts
\`\`\`
`;

class MockRuleSink implements RuleSinkPort {
  readonly name = 'mock-rule-sink';
  readonly proposed: RuleProposal[] = [];

  async propose(proposals: readonly RuleProposal[]): Promise<readonly RuleProposalResult[]> {
    this.proposed.push(...proposals);
    return proposals.map((p) => ({
      id: p.id,
      ok: true,
      entity: { id: p.id, status: 'probation' },
    }));
  }
}

const mockWorkLink: WorkLinkPort = {
  name: 'mock-work',
  async get(ids) {
    return {
      ok: true,
      items: ids.map((id) => ({
        id,
        title: id,
        state: id === 'item-open' ? ('open' as const) : ('closed' as const),
      })),
    };
  },
  async children() {
    return { ok: true, items: [] };
  },
  async close() {
    return { ok: true };
  },
  async reopen() {
    return { ok: true };
  },
};

describe('proposeRules', () => {
  test('proposes realized requirements and their actions whose claims hold', async () => {
    const store = new MemoryStore();
    await store.open();
    const parser = new MarkdownParser();
    const bases = new MemoryBaseStore();

    await ingest({
      store,
      parser,
      bases,
      files: [
        { source: 'plans/realized.md', text: PLAN_REALIZED },
        { source: 'plans/wip.md', text: PLAN_IN_PROGRESS },
      ],
      actor: 'nimish',
    });

    const checkReport: CheckReport = {
      plans: [
        {
          planId: 'plan/realized-feature',
          results: [
            {
              requirement: 'req-arch',
              claim: { kind: 'path', expression: 'src/core.ts', expect: true },
              outcome: 'holds',
              evidence: 'src/core.ts exists',
            },
            {
              requirement: 'req-arch',
              action: 'act-factory',
              claim: { kind: 'path', expression: 'src/factory.ts', expect: true },
              outcome: 'holds',
              evidence: 'src/factory.ts exists',
            },
            {
              requirement: 'req-broken',
              claim: { kind: 'path', expression: 'src/missing.ts', expect: true },
              outcome: 'violated',
              evidence: 'src/missing.ts does not exist',
            },
          ],
        },
        {
          planId: 'plan/wip-feature',
          results: [
            {
              requirement: 'req-done',
              claim: { kind: 'path', expression: 'src/done.ts', expect: true },
              outcome: 'holds',
              evidence: 'src/done.ts exists',
            },
            {
              requirement: 'req-open',
              claim: { kind: 'path', expression: 'src/wip.ts', expect: true },
              outcome: 'holds',
              evidence: 'src/wip.ts exists',
            },
          ],
        },
      ],
      holds: 4,
      violated: 1,
      unverifiable: 0,
    };

    const sink = new MockRuleSink();

    // 1. Dry run
    const dryRunReport = await proposeRules({
      store,
      checkReport,
      ruleSink: sink,
      worklink: mockWorkLink,
      actor: 'nimish',
      dryRun: true,
    });

    expect(sink.proposed).toHaveLength(0); // Nothing proposed to sink on dry run
    expect(dryRunReport.proposed).toHaveLength(3);

    // Proposals:
    // 1. req-arch (from realized plan)
    // 2. req-arch:act-factory (action under realized requirement)
    // 3. req-done (from wip plan, but work item is closed and claim holds)
    const proposedIds = dryRunReport.proposed.map((p) => p.proposal.id);
    expect(proposedIds).toEqual(['req-arch', 'req-arch:act-factory', 'req-done']);

    const reqArch = dryRunReport.proposed[0]?.proposal;
    expect(reqArch?.source).toBe('plan/realized-feature');
    expect(reqArch?.text).toContain('The architecture avoids global singletons.');
    expect(reqArch?.evidence).toContain('src/core.ts exists');

    // Skipped items
    const skippedIds = dryRunReport.skipped.map((s) => s.requirementId);
    expect(skippedIds).toContain('req-empty'); // No claims
    expect(skippedIds).toContain('req-broken'); // Claim violated
    expect(skippedIds).toContain('req-open'); // Work item still open

    // 2. Real run
    const realReport = await proposeRules({
      store,
      checkReport,
      ruleSink: sink,
      worklink: mockWorkLink,
      actor: 'nimish',
      dryRun: false,
    });

    expect(sink.proposed).toHaveLength(3);
    expect(realReport.proposed).toHaveLength(3);
    expect(realReport.proposed.every((p) => p.result?.ok === true)).toBe(true);
  });
});
