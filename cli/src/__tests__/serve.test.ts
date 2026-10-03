import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const DOC = encodeURIComponent('plan/live');

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

const post = (action: string, fields: Record<string, string>, token = server.token) =>
  fetch(`${server.url}/i/review-document/${DOC}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-patra-token': token },
    body: new URLSearchParams(fields),
  });

/** The revision a section shows, read from the page as a person's browser would see it. */
async function versionOf(id: string): Promise<string> {
  const page = await (await fetch(`${server.url}/d/review-document/${DOC}`)).text();
  const match = new RegExp(`data-patra-key="${id}"[^>]*data-patra-version="([^"]+)"`).exec(page);
  return match?.[1] ?? '';
}

describe('review --serve on patra', () => {
  test('lists plans with their pages, and serves a plan through the review-document template', async () => {
    const [plan] = await server.plans();
    expect(plan).toMatchObject({ id: 'plan/live', status: 'accepted', requirements: 2 });
    const response = await fetch(plan?.url ?? '');
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain('<script src="/assets/htmx.js"></script>');
    expect(page).toContain('data-patra-part="section" data-patra-key="alpha"');
    expect(page).toContain('Alpha as <code>planned</code>.');
    expect((await fetch(`${server.url}/d/review-document/plan%2Fnone`)).status).toBe(404);
  });

  test('an edit writes the plan file and swaps the section; a stale one comes back with why', async () => {
    const version = await versionOf('beta');
    expect(version).toMatch(/^r_/);
    const response = await post('edit', {
      _key: 'beta',
      _version: version,
      title: 'beta',
      text: 'Beta, sharpened.',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('HX-Retarget')).toContain('data-patra-key="beta"');
    expect(await response.text()).toContain('Beta, sharpened.');
    expect(readFileSync(join(root, 'plans', 'live.md'), 'utf8')).toContain('Beta, sharpened.');

    const stale = await post('edit', {
      _key: 'beta',
      _version: version,
      title: 'beta',
      text: 'Late',
    });
    expect(stale.status).toBe(409);
    const form = await stale.text();
    expect(form).toContain('data-patra-form="edit"');
    expect(form).toContain('It now reads: “Beta, sharpened.”');
  });

  test('suggest, accept and comment ask for a reload, and land in the log and files', async () => {
    const suggested = await post('suggest', {
      _key: 'alpha',
      _version: await versionOf('alpha'),
      title: 'alpha',
      text: 'Alpha, revised.',
      why: 'clearer',
    });
    expect(suggested.headers.get('HX-Refresh')).toBe('true');
    const [change] = readdirSync(join(root, 'changes')).filter((f) => f.endsWith('.md'));
    const accepted = await post('accept', { _key: (change ?? '').replace(/\.md$/, '') });
    expect(accepted.headers.get('HX-Refresh')).toBe('true');
    expect(readFileSync(join(root, 'plans', 'live.md'), 'utf8')).toContain('Alpha, revised.');

    const commented = await post('comment', { _key: 'alpha', body: 'Good.', quote: 'revised' });
    expect(commented.headers.get('HX-Refresh')).toBe('true');
    const page = await (await fetch(`${server.url}/d/review-document/${DOC}`)).text();
    expect(page).toContain('<mark data-mark="1">revised</mark>');
    expect(page).toContain('page-user');
  });

  test('a refused action answers with its reason; writes need the token', async () => {
    const refused = await post('reject', { _key: 'no-such-change', reason: 'x' });
    expect(refused.status).toBe(400);
    expect((await post('comment', { _key: 'alpha', body: 'x' }, 'wrong')).status).toBe(403);
  });
});
