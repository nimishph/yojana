import { describe, expect, test } from 'bun:test';
import { type ChangeParseResult, YojanaError } from '@cntxt-labs/yojana-core';
import { parseChange } from '../change.ts';
import { parsePlan } from '../parse.ts';

const codes = (result: ChangeParseResult) =>
  result.ok ? [] : result.issues.map((i) => `${i.code}@${i.line}`);

const change = (body: string, frontmatter = 'id: tweak\nplan: plan/p') =>
  `---\n${frontmatter}\n---\n${body}`;

describe('parseChange', () => {
  test('reads ADDED, MODIFIED and REMOVED sections in order', () => {
    const result = parseChange(
      'changes/tweak.md',
      change(
        [
          'Why: npx is slow.',
          '## MODIFIED Requirement: plugin loads {#req-a}',
          'Prefer a global anvesa.',
          '## ADDED Requirement: version check {#req-b}',
          'Warn on old versions.',
          '## REMOVED Requirement: old thing {#req-c}',
          'No longer needed.',
        ].join('\n'),
      ),
    );
    if (!result.ok) throw new YojanaError('TEST_FIXTURE', JSON.stringify(result.issues));
    expect(result.change).toMatchObject({
      id: 'tweak',
      planId: 'plan/p',
      title: 'tweak',
      source: 'changes/tweak.md',
    });
    expect(
      result.change.deltas.map((d) => [d.op, d.op === 'remove' ? d.id : d.requirement.id]),
    ).toEqual([
      ['modify', 'req-a'],
      ['add', 'req-b'],
      ['remove', 'req-c'],
    ]);
    const modify = result.change.deltas[0];
    expect(modify?.op === 'modify' && modify.requirement.text).toBe('Prefer a global anvesa.');
  });

  test('a requirement section without a marker is an issue', () => {
    expect(codes(parseChange('c.md', change('## Requirement: a {#a}\ntext')))).toEqual([
      'MISSING_CHANGE_MARKER@5',
    ]);
  });

  test('frontmatter needs a kebab-case id and a plan', () => {
    expect(
      codes(parseChange('c.md', change('## ADDED Requirement: a {#a}', 'id: Not OK'))),
    ).toEqual(['INVALID_CHANGE_ID@2', 'MISSING_PLAN@2']);
  });

  test('a change with nothing in it is an issue', () => {
    expect(codes(parseChange('c.md', change('Just prose.')))).toEqual(['EMPTY_CHANGE@undefined']);
  });

  test('change markers are not allowed in a plan', () => {
    const result = parsePlan('p.md', '---\nid: plan/p\n---\n## ADDED Requirement: a {#a}\n');
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toEqual(['CHANGE_MARKER_IN_PLAN']);
  });
});
