import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ParseResult, type Plan, YojanaError } from '@cntxt-labs/yojana-core';
import { parsePlan } from '../parse.ts';
import { renderPlan } from '../render.ts';

const EXAMPLE = join(import.meta.dir, '..', '..', '..', 'examples', 'plans', 'plugin-packaging.md');

function ok(result: ParseResult): Plan {
  if (!result.ok)
    throw new YojanaError(
      'TEST_EXPECTED_PLAN',
      `expected a plan, got ${JSON.stringify(result.issues)}`,
    );
  return result.plan;
}

function codes(result: ParseResult): string[] {
  return result.ok ? [] : result.issues.map((i) => `${i.code}@${i.line}`);
}

const plan = (body: string, frontmatter = 'id: plan/x\nstatus: draft') =>
  `---\n${frontmatter}\n---\n${body}`;

describe('parsePlan: the example plan', () => {
  const parsed = ok(parsePlan('plugin-packaging.md', readFileSync(EXAMPLE, 'utf8')));

  test('reads frontmatter', () => {
    expect(parsed.id).toBe('plan/plugin-packaging');
    expect(parsed.title).toBe('Ship anvesa as a Claude Code plugin');
    expect(parsed.status).toBe('accepted');
    expect(parsed.workItems).toEqual(['anv-yp2']);
  });

  test('reads requirements with their claims', () => {
    expect(parsed.requirements.map((r) => r.id)).toEqual(['req-no-global', 'req-core-no-cli']);
    const [first] = parsed.requirements;
    expect(first?.text).toBe(
      "The plugin's MCP server starts through `npx` when `anvesa` is not on PATH.",
    );
    expect(first?.claims).toEqual([
      { kind: 'path', expression: '.claude-plugin/plugin.json', expect: true },
    ]);
    expect(parsed.requirements[1]?.claims[0]?.expect).toBe(false);
  });

  test('keeps prose in document order', () => {
    expect(parsed.parts.map((p) => p.kind)).toEqual(['prose', 'requirement', 'requirement']);
    expect(parsed.parts[0]).toEqual({
      kind: 'prose',
      markdown: 'Why: anvesa has an MCP server and a skill, but users wire both up by hand.',
    });
  });

  test('round-trips through render', () => {
    expect(ok(parsePlan(parsed.source, renderPlan(parsed)))).toEqual(parsed);
  });

  test('rendering is stable', () => {
    const once = renderPlan(parsed);
    expect(renderPlan(ok(parsePlan(parsed.source, once)))).toBe(once);
  });
});

describe('parsePlan: structure', () => {
  test('headings inside code fences are text, not sections', () => {
    const parsed = ok(
      parsePlan('p.md', plan('## Requirement: a {#a}\n\n```md\n## Requirement: fake {#b}\n```\n')),
    );
    expect(parsed.requirements.map((r) => r.id)).toEqual(['a']);
    expect(parsed.requirements[0]?.text).toContain('## Requirement: fake {#b}');
  });

  test('another level-2 heading ends a requirement and starts prose', () => {
    const parsed = ok(parsePlan('p.md', plan('## Requirement: a {#a}\none\n## Notes\ntwo\n')));
    expect(parsed.requirements[0]?.text).toBe('one');
    expect(parsed.parts[1]).toEqual({ kind: 'prose', markdown: '## Notes\ntwo' });
  });

  test('defaults: status draft, no beads, title from id', () => {
    const parsed = ok(parsePlan('p.md', plan('', 'id: plan/x')));
    expect(parsed).toMatchObject({ status: 'draft', workItems: [], title: 'plan/x' });
  });

  test('the H1 supplies the title when the frontmatter has none', () => {
    expect(ok(parsePlan('p.md', plan('\n# Hello\n'))).title).toBe('Hello');
  });

  test('a claim defaults to expect: true', () => {
    const parsed = ok(
      parsePlan(
        'p.md',
        plan('## Requirement: a {#a}\n```yojana:claim\nkind: wql\nexpression: //x\n```\n'),
      ),
    );
    expect(parsed.requirements[0]?.claims).toEqual([
      { kind: 'wql', expression: '//x', expect: true },
    ]);
  });

  test('CRLF input parses like LF input', () => {
    const text = plan('## Requirement: a {#a}\nbody\n');
    expect(ok(parsePlan('p.md', text.replaceAll('\n', '\r\n')))).toEqual(
      ok(parsePlan('p.md', text)),
    );
  });
});

describe('parsePlan: revisions', () => {
  const revisionOf = (body: string) =>
    ok(parsePlan('p.md', plan(`## Requirement: a {#a}\n${body}`))).requirements[0]?.revision;

  test('whitespace-only edits keep the revision', () => {
    expect(revisionOf('text  \n\n')).toBe(revisionOf('text'));
  });

  test('editing prose or a claim changes the revision', () => {
    const claim = (expectValue: boolean) =>
      `text\n\`\`\`yojana:claim\nkind: wql\nexpression: //x\nexpect: ${expectValue}\n\`\`\`\n`;
    expect(revisionOf('text')).not.toBe(revisionOf('text!'));
    expect(revisionOf(claim(true))).not.toBe(revisionOf(claim(false)));
    expect(revisionOf(claim(true))).not.toBe(revisionOf('text'));
  });
});

describe('parsePlan: issues', () => {
  test('missing frontmatter', () => {
    expect(codes(parsePlan('p.md', '# no frontmatter\n'))).toEqual(['MISSING_FRONTMATTER@1']);
    expect(codes(parsePlan('p.md', '---\nid: x\n'))).toEqual(['MISSING_FRONTMATTER@1']);
  });

  test('bad frontmatter values', () => {
    expect(codes(parsePlan('p.md', plan('', 'status: done')))).toEqual([
      'MISSING_PLAN_ID@2',
      'INVALID_STATUS@2',
    ]);
    expect(codes(parsePlan('p.md', plan('', 'id: x\nbeads: anv-1')))).toEqual(['INVALID_BEADS@2']);
    expect(codes(parsePlan('p.md', plan('', 'id: [unclosed')))).toEqual(['INVALID_FRONTMATTER@2']);
  });

  test('requirement ids: missing, invalid, duplicate (with lines)', () => {
    const body = [
      '## Requirement: no id', // line 5
      '## Requirement: bad {#Bad Id}', // 6
      '## Requirement: ok {#a}', // 7
      '## Requirement: again {#a}', // 8
    ].join('\n');
    expect(codes(parsePlan('p.md', plan(body)))).toEqual([
      'MISSING_REQUIREMENT_ID@5',
      'INVALID_REQUIREMENT_ID@6',
      'DUPLICATE_REQUIREMENT_ID@8',
    ]);
  });

  test('malformed claims, misplaced claims and unknown blocks', () => {
    const body = [
      '```yojana:claim', // 5: outside a requirement
      'kind: wql',
      'expression: //x',
      '```',
      '## Requirement: a {#a}', // 9
      '```yojana:claim', // 10: no expression
      'kind: wql',
      '```',
      '```yojana:claim', // 13: expect not boolean
      'kind: wql',
      'expression: //x',
      'expect: maybe',
      '```',
      '```yojana:todo', // 18
      '```',
    ].join('\n');
    expect(codes(parsePlan('p.md', plan(body)))).toEqual([
      'CLAIM_OUTSIDE_REQUIREMENT@5',
      'INVALID_CLAIM@10',
      'INVALID_CLAIM@13',
      'UNKNOWN_BLOCK@18',
    ]);
  });

  test('unclosed fence and title mismatch', () => {
    expect(codes(parsePlan('p.md', plan('# Other\n```js\nx', 'id: x\ntitle: Mine')))).toEqual([
      'TITLE_MISMATCH@5',
      'UNCLOSED_FENCE@6',
    ]);
  });
});

describe('renderPlan: claim values', () => {
  const withExpression = (expression: string): Plan => ({
    id: 'plan/x',
    title: 'x',
    status: 'draft',
    workItems: [],
    parts: [{ kind: 'requirement', id: 'a' }],
    source: 'p.md',
    requirements: [
      {
        id: 'a',
        title: 'a',
        text: 't',
        revision: 'r_0',
        claims: [{ kind: 'wql', expression, expect: true }],
      },
    ],
  });

  test('stays plain when YAML reads it back unchanged', () => {
    const text = renderPlan(withExpression('//file[@path=".claude-plugin/plugin.json"]'));
    expect(text).toContain('expression: //file[@path=".claude-plugin/plugin.json"]\n');
  });

  test.each(['true', '123', 'a: b', 'x # y', "it's", '[list]', '- dash', '  padded'])(
    'quotes %p and reads it back exactly',
    (expression) => {
      const parsed = ok(parsePlan('p.md', renderPlan(withExpression(expression))));
      expect(parsed.requirements[0]?.claims[0]?.expression).toBe(expression.trim());
    },
  );
});

describe('parsePlan: git conflicts', () => {
  test('an unresolved merge conflict is an issue on each marker line', () => {
    const body = [
      '## Requirement: a {#a}', // 5
      '<<<<<<< HEAD', // 6
      'ours',
      '=======', // 8
      'theirs',
      '>>>>>>> alice', // 10
    ].join('\n');
    expect(codes(parsePlan('p.md', plan(body)))).toEqual([
      'GIT_CONFLICT_MARKER@6',
      'GIT_CONFLICT_MARKER@8',
      'GIT_CONFLICT_MARKER@10',
    ]);
  });

  test('markers inside a code fence are example text', () => {
    const body = '## Requirement: a {#a}\n```\n<<<<<<< HEAD\n=======\n>>>>>>> x\n```\n';
    expect(parsePlan('p.md', plan(body)).ok).toBe(true);
  });
});
