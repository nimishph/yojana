import { describe, expect, test } from 'bun:test';
import { YojanaError } from '@cntxt-labs/yojana-core';
import { importAndValidate } from '../import.ts';
import { parsePlan } from '../parse.ts';

const ROADMAP = `# Evolution Plan (Medha-Inspired)

> Blueprint for upcoming work.

## 1. Summary

We port hot paths first.

## 2. Index

| Bead ID | Priority | Status | Title |
| :--- | :---: | :--- | :--- |
| \`anv-1mh\` | P2 | Open | Config schema |
| \`anv-ja8\` | P1 | Open | SIMD |

| Target | Runner |
| --- | --- |
| linux-x64 | ubuntu |

## 3. Specifications

### \`anv-1mh\`: Support \`$schema\` in config

#### Motivation
Adding $schema throws today.

\`\`\`text
## not a heading, it is in a fence
\`\`\`

### \`anv-ja8\`: SIMD vector math

Batch top-k in native memory.

### \`anv-ja8\`: SIMD vector math

Same title again.

## 4. Platforms

Add darwin-x64.
`;

describe('importRoadmap', () => {
  const { report, issues } = importAndValidate(ROADMAP, {
    source: 'ROADMAP.md',
    planId: 'plan/evolution',
  });

  test('produces a valid plan', () => {
    expect(issues).toEqual([]);
  });

  test('requirements come from the headings that name beads, with their links', () => {
    expect(report.level).toBe(3);
    expect(report.prefix).toEqual({ value: 'anv', detected: true });
    expect(report.requirements).toEqual([
      { id: 'req-support-schema-in-config', beads: ['anv-1mh'] },
      { id: 'req-simd-vector-math', beads: ['anv-ja8'] },
      { id: 'req-simd-vector-math-2', beads: ['anv-ja8'] },
    ]);
    expect(report.beads).toEqual(['anv-1mh', 'anv-ja8']);
  });

  test('status tables go, other tables and prose stay, fences are respected', () => {
    expect(report.droppedTables).toBe(1);
    expect(report.markdown).not.toContain('| Bead ID |');
    expect(report.markdown).toContain('| Target | Runner |');
    expect(report.markdown).toContain('## 1. Summary');
    expect(report.markdown).toContain('## 4. Platforms');
    expect(report.markdown).toContain('## not a heading, it is in a fence');

    const parsed = parsePlan('p.md', report.markdown);
    if (!parsed.ok) throw new YojanaError('TEST_FIXTURE', JSON.stringify(parsed.issues));
    const schema = parsed.plan.requirements[0];
    expect(schema?.title).toBe('Support $schema in config');
    expect(schema?.workItems).toEqual(['anv-1mh']);
    expect(schema?.text).toContain('### Motivation');
    expect(parsed.plan.title).toBe('Evolution Plan (Medha-Inspired)');
    expect(parsed.plan.workItems).toEqual(['anv-1mh', 'anv-ja8']);
  });

  test('without bead ids, every ## section is a requirement', () => {
    const plain = '# Plain\n\n## First thing\n\nDo it.\n\n## Second thing\n\nThen this.\n';
    const result = importAndValidate(plain, { source: 'x.md', planId: 'plan/plain' });
    expect(result.issues).toEqual([]);
    expect(result.report.requirements.map((r) => r.id)).toEqual([
      'req-first-thing',
      'req-second-thing',
    ]);
    expect(result.report.prefix).toBeUndefined();
  });

  test('a given prefix wins over detection', () => {
    const result = importAndValidate(ROADMAP, {
      source: 'r.md',
      planId: 'plan/x',
      prefix: 'zzz',
    });
    expect(result.report.beads).toEqual([]);
    expect(result.report.level).toBe(2);
  });
});
