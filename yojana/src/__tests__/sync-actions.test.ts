import { describe, expect, test } from 'bun:test';
import type { WorkCreateResult, WorkLinkPort } from '@cntxt-labs/yojana-core';
import { MarkdownParser } from '@cntxt-labs/yojana-markdown';
import { syncActions } from '../sync-actions.ts';

const parser = new MarkdownParser();

const PLAN = `---
id: plan/demo
beads: [plan-epic]
---

# Demo

## Requirement: feature 1 {#req-1 beads=req-epic}

### Actions
- Unlinked action under req with bead {#act-1}
- Already linked action {#act-2 bead=existing-1}

## Requirement: feature 2 {#req-2}

### Actions
- Action inherits plan epic {#act-3}
`;

function fakeTracker(createdIds: string[]): WorkLinkPort {
  let counter = 1;
  return {
    name: 'fake',
    async get() {
      return { ok: true, items: [] };
    },
    async children() {
      return { ok: true, items: [] };
    },
    async create(options): Promise<WorkCreateResult> {
      const id = `new-${counter++}`;
      createdIds.push(`${id} (parent: ${options.parent ?? 'none'})`);
      return { ok: true, id };
    },
  };
}

describe('syncActions', () => {
  test('creates beads with parent from requirement or plan, and writes ids back', async () => {
    const created: string[] = [];
    const tracker = fakeTracker(created);
    let written = '';
    const files = [{ source: 'plans/demo.md', text: PLAN }];

    const report = await syncActions({
      parser,
      worklink: tracker,
      files,
      writePlan: (_src, text) => {
        written = text;
      },
    });

    expect(report.dryRun).toBe(false);
    expect(report.files.length).toBe(1);
    expect(report.files[0]?.actions).toEqual([
      {
        requirement: 'req-1',
        action: 'act-1',
        title: 'Unlinked action under req with bead',
        bead: 'new-1',
        parent: 'req-epic',
      },
      {
        requirement: 'req-2',
        action: 'act-3',
        title: 'Action inherits plan epic',
        bead: 'new-2',
        parent: 'plan-epic',
      },
    ]);
    expect(created).toEqual(['new-1 (parent: req-epic)', 'new-2 (parent: plan-epic)']);

    // Check that written file text contains the new beads
    expect(written).toContain('- Unlinked action under req with bead {#act-1 bead=new-1}');
    expect(written).toContain('- Already linked action {#act-2 bead=existing-1}');
    expect(written).toContain('- Action inherits plan epic {#act-3 bead=new-2}');

    // Parse the updated text to verify it's valid markdown
    const reparsed = parser.parse('plans/demo.md', written);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(reparsed.plan.requirements[0]?.actions?.[0]?.workItems).toEqual(['new-1']);
      expect(reparsed.plan.requirements[0]?.actions?.[1]?.workItems).toEqual(['existing-1']);
      expect(reparsed.plan.requirements[1]?.actions?.[0]?.workItems).toEqual(['new-2']);
    }
  });

  test('dry-run reports actions without creating or writing', async () => {
    const created: string[] = [];
    const tracker = fakeTracker(created);
    let wrote = false;
    const files = [{ source: 'plans/demo.md', text: PLAN }];

    const report = await syncActions({
      parser,
      worklink: tracker,
      files,
      writePlan: () => {
        wrote = true;
      },
      dryRun: true,
    });

    expect(report.dryRun).toBe(true);
    expect(report.files[0]?.actions.map((a) => [a.action, a.bead, a.parent])).toEqual([
      ['act-1', '(dry-run)', 'req-epic'],
      ['act-3', '(dry-run)', 'plan-epic'],
    ]);
    expect(created).toEqual([]);
    expect(wrote).toBe(false);
  });

  test('read-only worklink throws WORKLINK_READONLY', async () => {
    const readOnlyTracker: WorkLinkPort = {
      name: 'readonly',
      async get() {
        return { ok: true, items: [] };
      },
      async children() {
        return { ok: true, items: [] };
      },
    };
    const files = [{ source: 'plans/demo.md', text: PLAN }];
    await expect(syncActions({ parser, worklink: readOnlyTracker, files })).rejects.toThrow(
      /does not support creating items/,
    );
  });

  test('already linked plan has nothing to sync', async () => {
    const created: string[] = [];
    const tracker = fakeTracker(created);
    const fullyLinkedPlan = `---
id: plan/linked
---

## Requirement: done {#req}

### Actions
- Already linked {#act-1 bead=b-1}
`;
    const report = await syncActions({
      parser,
      worklink: tracker,
      files: [{ source: 'plans/linked.md', text: fullyLinkedPlan }],
    });
    expect(report.files).toEqual([]);
    expect(created).toEqual([]);
  });
});
