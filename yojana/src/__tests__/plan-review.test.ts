import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadTemplate,
  loadTheme,
  pageHead,
  renderPage,
  renderPart,
  themeProblems,
} from '@cntxt-labs/patra-core';
import { themeFile } from '@cntxt-labs/patra-themes';
import { YojanaError } from '@cntxt-labs/yojana-core';

const REPO = join(import.meta.dir, '..', '..', '..');
const DIR = join(REPO, 'templates', 'plan-review');
const example = JSON.parse(readFileSync(join(DIR, 'example.json'), 'utf8'));

const result = loadTemplate(DIR);
if (!result.ok) throw new YojanaError('TEST_FIXTURE', JSON.stringify(result.problems, null, 2));
const template = result.template;

describe('plan-review template', () => {
  test('loads clean and fits the default theme', () => {
    expect(template.manifest.id).toBe('plan-review');
    expect(Object.keys(template.manifest.actions).sort()).toEqual([
      'accept',
      'approve',
      'comment',
      'confirm',
      'decide',
      'decline',
      'decline-section',
      'edit',
      'reject',
      'remove',
      'reply',
      'suggest',
    ]);
    const theme = loadTheme(themeFile('default'));
    if (!theme.ok) throw new YojanaError('TEST_FIXTURE', 'theme');
    expect(themeProblems(theme.theme, template.manifest.tokens)).toEqual([]);
  });

  test('every token the layout uses is declared in the manifest', () => {
    const used = new Set(
      template.styles.flatMap((s) => s.css.match(/var\((--[a-z0-9-]+)\)/g) ?? []),
    );
    const names = [...used].map((v) => v.slice('var('.length, -')'.length));
    expect(names.filter((n) => !template.manifest.tokens.includes(n))).toEqual([]);
  });

  test('requirement list and comments columns are sticky with independent scroll, static under 1100px', () => {
    const css = template.styles.map((s) => s.css).join('\n');
    expect(css).toMatch(/\.rd-outline\s*\{[^}]*position:\s*sticky;/);
    expect(css).toMatch(/\.rd-outline\s*\{[^}]*overflow-y:\s*auto;/);
    expect(css).toMatch(/\.rd-rail\s*\{[^}]*position:\s*sticky;/);
    expect(css).toMatch(/\.rd-rail\s*\{[^}]*overflow-y:\s*auto;/);

    const narrowAt = css.indexOf('@media (max-width: 1100px)');
    expect(narrowAt).toBeGreaterThan(0);
    const narrow = css.slice(narrowAt, css.indexOf('@media print'));
    expect(narrow).toMatch(/\.rd-outline\s*\{[^}]*position:\s*static;/);
    expect(narrow).toMatch(/\.rd-outline\s*\{[^}]*overflow-y:\s*visible;/);
    expect(narrow).toMatch(/\.rd-rail\s*\{[^}]*position:\s*static;/);
    expect(narrow).toMatch(/\.rd-rail\s*\{[^}]*overflow-y:\s*visible;/);
  });

  test('printing shows the document and its review, without controls', () => {
    const css = template.styles.map((s) => s.css).join('\n');
    const at = css.indexOf('@media print');
    expect(at).toBeGreaterThan(0);
    const print = css.slice(at);
    const hidden = (/([^{}]+)\{\s*display: none !important;/.exec(print)?.[1] ?? '')
      .split(',')
      .map((s) => s.trim());
    for (const control of [
      '.rd-tools',
      '.rd-outline',
      '.rd-tabs',
      '.actions',
      '.slot',
      '.live-only',
    ])
      expect(hidden).toContain(control);
    // Every rail panel the live page hid behind a tab prints, but the activity feed.
    expect(hidden).toContain('.rd-panel[data-patra-panel="activity"]');
    expect(print).toContain('html[data-patra-live] .rd-panel[hidden]');
  });

  test('the example content is valid and renders the whole page', () => {
    expect(template.check(example)).toEqual([]);
    const theme = readFileSync(themeFile('default'), 'utf8');
    const page = renderPage(template, example, { head: pageHead(template, theme) });
    if (!page.ok) throw new YojanaError('TEST_FIXTURE', JSON.stringify(page.problems));
    const html = page.html;
    expect(html).toContain('<title>Anvesa architecture and evolution</title>');
    expect(html).toContain('--surface-page');
    expect(html).toContain('data-mode="suggest"');
    expect(html).toContain('<meter min="0" max="7" value="0"></meter>0/7 beads');
    // Sections, outline, threads, changes, activity, each tagged for the runtime.
    expect(html.match(/data-patra-part="section"/g)).toHaveLength(2);
    expect(html.match(/data-patra-part="outline-item"/g)).toHaveLength(2);
    expect(html).toContain('data-patra-version="r_357f348272f80f4c"');
    expect(html).toContain('<mark data-mark="t1">serves 25-40 line topics</mark>');
    // Each quote is highlighted once: the body is not repeated for sections without a change.
    expect(html.match(/data-mark="t1"/g)).toHaveLength(1);
    expect(html.match(/class="sec-body when-change"/g)).toHaveLength(1);
    expect(html).toContain('<ins>');
    expect(html).toContain('data-patra-action="decide" data-patra-item="anv-35b"');
    expect(html).toContain('class="card thread outdated"');
    expect(html).toContain('data-patra-action="accept"');
    // A callout asks for a decision on the whole document, with what to weigh first.
    expect(html).toContain('data-patra-part="callout" data-patra-key="status"');
    expect(html).toContain('<li class="warning">5 of 7 requirements not approved</li>');
    expect(html).toContain(
      'data-patra-action="confirm" data-patra-item="" data-patra-decision="accepted"',
    );
    // A section's own buttons come before edit, suggest and comment.
    expect(html).toContain('data-patra-action="approve"');
    // Actions under requirements render with their state, bead items, claims, and notes.
    expect(html).toContain('class="sec-actions"');
    expect(html).toContain('data-action-id="act-primer-cmd"');
    expect(html).toContain('class="sec-action is-done"');
    expect(html).toContain('data-action-id="act-primer-test"');
    expect(html).toContain('anv-35b.1 · closed');
    expect(html).toContain('path cli/src/primer.ts · 1 match');
    // No template syntax leaks into the output.
    expect(html).not.toMatch(/\{\{|\}\}/);
  });

  test('one section renders alone, as a partial update', () => {
    const part = renderPart(template, 'section', example.sections[0]);
    if (!part.ok) throw new YojanaError('TEST_FIXTURE', JSON.stringify(part.problems));
    expect(part.html.startsWith('<section class="sec" id="req-primer"')).toBe(true);
    expect(part.html).toContain('Every claim holds but anv-35b is still open.');
    expect(part.html).toContain('data-action-id="act-primer-cmd"');
    expect(part.html).toContain('Add primer CLI command');
    expect(part.html).toContain('Add anti-drift test');
  });

  test('forms render with what the person typed and the reason a save was refused', () => {
    const form = renderPart(template, 'form-edit', {
      values: { title: 'T', text: 'my <b>edit</b>' },
      error: 'req-primer changed since this page was loaded',
    });
    expect(form.ok && form.html).toContain('my &lt;b&gt;edit&lt;/b&gt;');
    expect(form.ok && form.html).toContain('role="alert"');
  });

  test('the confirm and decline forms show what is being decided', () => {
    const callout = example.callouts[0];
    const confirm = renderPart(template, 'form-confirm', {
      ...callout,
      values: { decision: 'accepted' },
    });
    expect(confirm.ok && confirm.html).toContain('name="decision" value="accepted"');
    expect(confirm.ok && confirm.html).toContain('claude proposes moving this plan to accepted');
    const decline = renderPart(template, 'form-decline', { ...callout, values: {} });
    expect(decline.ok && decline.html).toContain('name="reason" value="" required');
  });

  test('a thread offers Remove where the app allows it, and shows a removed comment', () => {
    const thread = {
      id: 'n_1',
      section: 'req-primer',
      author: 'nimish',
      body: 'Root text',
      quote: 'quoted',
      removable: true,
      replies: [
        { id: 'n_2', author: 'claude', agent: true, body: 'Mine', removable: true },
        { id: 'n_3', author: 'ana', body: 'Theirs' },
      ],
    };
    expect(template.check({ ...example, threads: [thread] })).toEqual([]);
    const live = renderPart(template, 'thread', thread);
    if (!live.ok) throw new YojanaError('TEST_FIXTURE', JSON.stringify(live.problems));
    expect(live.html).toContain('<button type="button" class="link" data-patra-action="remove">');
    expect(live.html).toContain('data-patra-action="remove" data-patra-item="n_2"');
    expect(live.html).not.toContain('data-patra-item="n_3"');

    const removed = renderPart(template, 'thread', { ...thread, removable: false, removed: true });
    expect(removed.ok && removed.html).toContain('This comment was removed.');
    expect(removed.ok && removed.html).not.toContain('Root text');
    expect(removed.ok && removed.html).not.toContain('quoted');
    expect(removed.ok && removed.html).toContain('Theirs');

    const reply = renderPart(template, 'form-remove', { values: { item: 'n_2' } });
    expect(reply.ok && reply.html).toContain('name="item" value="n_2"');
    expect(reply.ok && reply.html).toContain('Remove this reply?');
    const root = renderPart(template, 'form-remove', { values: {} });
    expect(root.ok && root.html).toContain('Remove this comment?');
  });

  test('a section can be declined with a reason', () => {
    const section = {
      ...example.sections[0],
      buttons: [
        { action: 'approve', label: 'Approve' },
        { action: 'decline-section', label: 'Decline' },
      ],
    };
    expect(template.check({ ...example, sections: [section] })).toEqual([]);
    const part = renderPart(template, 'section', section);
    expect(part.ok && part.html).toContain('data-patra-action="decline-section"');
    const form = renderPart(template, 'form-decline-section', { values: {} });
    expect(form.ok && form.html).toContain('name="reason" value="" required');
  });
});

describe('plan-review content errors', () => {
  test('one problem per place: no wrapper or repeated errors', () => {
    const bad = structuredClone(example);
    bad.sections[0].health = 'great';
    bad.document.mode = 'review';
    expect(template.check(bad).map((p) => p.at)).toEqual(['/document/mode', '/sections/0/health']);
  });

  test('an unknown property is reported as not allowed', () => {
    const bad = structuredClone(example);
    bad.sections[0].colour = 'red';
    expect(template.check(bad)).toEqual([
      {
        file: 'content',
        at: '/sections/0/colour',
        code: 'INVALID_CONTENT',
        message: '/sections/0/colour is not allowed here',
      },
    ]);
  });
});
