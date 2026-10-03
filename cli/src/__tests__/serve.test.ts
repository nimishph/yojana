import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkLinkPort } from '@cntxt-labs/yojana-core';
import { run } from '../main.ts';
import { type ReviewServer, startReviewServer } from '../serve.ts';

const PLAN = `---
id: plan/live
status: accepted
---

## Requirement: alpha {#alpha}

Alpha as \`planned\`.

## Requirement: beta {#beta}

Beta as planned.
`;

const noWork: WorkLinkPort = {
  name: 'none',
  get: async () => ({ ok: true, items: [] }),
  children: async () => ({ ok: true, items: [] }),
};

let root = '';
let server: ReviewServer;
const planUrl = () => `${server.url}/plan/plan%2Flive`;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'yojana-serve-'));
  mkdirSync(join(root, 'plans'));
  writeFileSync(join(root, 'plans', 'live.md'), PLAN);
  process.env.YOJANA_ACTOR = 'tester';
  await run(['ingest', '--root', root], () => undefined);
  server = startReviewServer({
    root,
    plansDir: undefined,
    changesDir: undefined,
    port: 0,
    actor: 'page-user',
    runCheck: false,
    verifiers: () => [],
    worklink: () => noWork,
  });
});

afterAll(() => {
  server.stop();
  rmSync(root, { recursive: true, force: true });
});

/** The revision an edit form is opened on, as the page would get it. */
const revisionOf = async (requirement: string): Promise<string> => {
  const form = await (await fetch(`${planUrl()}/form/edit/${requirement}`)).text();
  return /name="revision" value="([^"]+)"/.exec(form)?.[1] ?? '';
};

/** Post the way htmx does: form-encoded, with the page's token header. */
const post = (action: string, fields: Record<string, string>, token = server.token) =>
  fetch(`${server.url}/api/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-yojana-token': token },
    body: new URLSearchParams(fields),
  });

const planText = () => readFileSync(join(root, 'plans', 'live.md'), 'utf8');

describe('review --serve (htmx)', () => {
  test('serves the page with htmx, its token, and form links; and htmx itself', async () => {
    expect(await (await fetch(server.url)).text()).toContain('/plan/plan%2Flive');
    const page = await (await fetch(planUrl())).text();
    expect(page).toContain('<script src="/static/htmx.js"></script>');
    expect(page).toContain(server.token);
    expect(page).toContain('hx-get="/plan/plan%2Flive/form/edit/alpha"');
    expect(page).toContain('id="selbar"');
    const htmx = await fetch(`${server.url}/static/htmx.js`);
    expect(htmx.headers.get('content-type')).toContain('javascript');
    expect(await htmx.text()).toContain('htmx');
    expect((await fetch(`${server.url}/plan/plan%2Fnone`)).status).toBe(404);
  });

  test('forms come from the server, with the quote from a selection', async () => {
    const commentForm = await (
      await fetch(`${planUrl()}/form/comment/alpha?quote=${encodeURIComponent('as planned')}`)
    ).text();
    expect(commentForm).toContain('hx-post="/api/comment"');
    expect(commentForm).toContain('<blockquote>as planned</blockquote>');
    const editForm = await (await fetch(`${planUrl()}/form/edit/alpha`)).text();
    expect(editForm).toContain('Alpha as `planned`.');
    expect((await fetch(`${planUrl()}/form/edit/nope`)).status).toBe(404);
  });

  test('writes without the token are refused and change nothing', async () => {
    const before = planText();
    const response = await post('edit', { planId: 'plan/live', requirement: 'alpha' }, 'wrong');
    expect(response.status).toBe(403);
    expect(planText()).toBe(before);
  });

  test('a comment on a rendered selection lands and comes back as the swapped section', async () => {
    // The page shows `planned` without backticks; the selection carries none.
    const response = await post('comment', {
      planId: 'plan/live',
      requirement: 'alpha',
      body: 'Why alpha first?',
      quote: 'as planned',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('HX-Retarget')).toBe('[id="alpha"]');
    expect(response.headers.get('HX-Reswap')).toBe('outerHTML');
    const section = await response.text();
    expect(section).toContain('Why alpha first?');
    expect(section).toContain('<section class="req" id="alpha">');
  });

  test('a refused comment comes back as the form, text kept, with the reason', async () => {
    const response = await post('comment', {
      planId: 'plan/live',
      requirement: 'alpha',
      body: 'Keep me.',
      quote: 'nowhere in the text',
    });
    expect(response.status).toBe(400);
    const form = await response.text();
    expect(form).toContain('Keep me.');
    expect(form).toContain('class="error"');
  });

  test('an edit lands in the file and swaps the section; the old revision is then refused', async () => {
    const shown = await revisionOf('alpha');
    const saved = await post('edit', {
      planId: 'plan/live',
      requirement: 'alpha',
      revision: shown,
      title: 'alpha',
      text: 'Alpha, edited on the page.',
    });
    expect(saved.status).toBe(200);
    expect(await saved.text()).toContain('Alpha, edited on the page.');
    expect(planText()).toContain('Alpha, edited on the page.');

    const stale = await post('edit', {
      planId: 'plan/live',
      requirement: 'alpha',
      revision: shown,
      title: 'alpha',
      text: 'A late edit.',
    });
    expect(stale.status).toBe(409);
    const form = await stale.text();
    expect(form).toContain('It now reads:');
    expect(form).toContain('A late edit.');
  });

  test('suggestions open changes; accept applies one, the other can only be rejected', async () => {
    const shown = await revisionOf('beta');
    const suggest = (text: string) =>
      post('suggest', {
        planId: 'plan/live',
        requirement: 'beta',
        revision: shown,
        title: 'beta',
        text,
        why: 'Sharper wording.',
      });
    expect((await suggest('Beta, as suggested.')).headers.get('HX-Refresh')).toBe('true');
    expect((await suggest('Beta, another idea.')).headers.get('HX-Refresh')).toBe('true');
    const ids = readdirSync(join(root, 'changes'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -'.md'.length));
    const proposes = (id: string, words: string) =>
      readFileSync(join(root, 'changes', `${id}.md`), 'utf8').includes(words);
    const accepted = ids.find((id) => proposes(id, 'as suggested')) ?? '';
    const rejected = ids.find((id) => proposes(id, 'another idea')) ?? '';
    expect(await (await fetch(planUrl())).text()).toContain('Open changes');

    expect((await post('accept', { changeId: accepted })).headers.get('HX-Refresh')).toBe('true');
    expect(planText()).toContain('Beta, as suggested.');
    expect(existsSync(join(root, 'changes', `${accepted}.md`))).toBe(false);

    // Written against the same revision, the other one can no longer apply.
    const refused = await post('accept', { changeId: rejected });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('changed since this change was opened');
    expect((await post('reject', { changeId: rejected, reason: '' })).status).toBe(400);
    expect((await post('reject', { changeId: rejected, reason: 'Superseded.' })).status).toBe(200);
    expect(readdirSync(join(root, 'changes', 'abandoned'))[0]).toContain(rejected);
  });
});
