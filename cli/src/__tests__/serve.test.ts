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

Alpha as planned.

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

const revisionOf = async (requirement: string): Promise<string> => {
  const page = await (await fetch(`${server.url}/plan/plan%2Flive`)).text();
  const data = JSON.parse(
    /<script type="application\/json" id="yojana-data">(.*?)<\/script>/s.exec(page)?.[1] ?? '{}',
  );
  return data.requirements[requirement].revision;
};

const post = (action: string, body: object, token = server.token) =>
  fetch(`${server.url}/api/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-yojana-token': token },
    body: JSON.stringify(body),
  });

const planText = () => readFileSync(join(root, 'plans', 'live.md'), 'utf8');

describe('review --serve', () => {
  test('lists plans and serves the live page with its token and controls', async () => {
    expect(await (await fetch(server.url)).text()).toContain('/plan/plan%2Flive');
    const page = await (await fetch(`${server.url}/plan/plan%2Flive`)).text();
    expect(page).toContain(server.token);
    expect(page).toContain('data-act="edit"');
    expect(page).toContain('data-act="suggest"');
    expect((await fetch(`${server.url}/plan/plan%2Fnone`)).status).toBe(404);
  });

  test('writes without the token are refused and change nothing', async () => {
    const before = planText();
    const response = await post('edit', { planId: 'plan/live', requirement: 'alpha' }, 'wrong');
    expect(response.status).toBe(403);
    expect(planText()).toBe(before);
  });

  test('a comment lands in the log', async () => {
    const response = await post('comment', {
      planId: 'plan/live',
      requirement: 'alpha',
      body: 'Why alpha first?',
      quote: 'as planned',
    });
    expect(response.status).toBe(200);
    const page = await (await fetch(`${server.url}/plan/plan%2Flive`)).text();
    expect(page).toContain('Why alpha first?');
    expect(page).toContain('<mark>as planned</mark>');
  });

  test('an edit lands in the file and the log; the same edit on the old revision is refused', async () => {
    const shown = await revisionOf('alpha');
    const saved = await post('edit', {
      planId: 'plan/live',
      requirement: 'alpha',
      revision: shown,
      title: 'alpha',
      text: 'Alpha, edited on the page.',
    });
    expect(saved.status).toBe(200);
    expect(planText()).toContain('Alpha, edited on the page.');
    expect(await revisionOf('alpha')).not.toBe(shown);

    const stale = await post('edit', {
      planId: 'plan/live',
      requirement: 'alpha',
      revision: shown,
      title: 'alpha',
      text: 'A late edit.',
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      code: 'STALE',
      current: { text: 'Alpha, edited on the page.' },
    });
  });

  test('a suggestion opens a change; accept applies it, reject closes another with a reason', async () => {
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
    const first = await suggest('Beta, as suggested.');
    expect(first.status).toBe(200);
    const second = await suggest('Beta, another idea.');
    expect(second.status).toBe(200);
    const ids = readdirSync(join(root, 'changes'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -'.md'.length));
    expect(ids).toHaveLength(2);
    expect(planText()).toContain('Beta as planned.');

    const page = await (await fetch(`${server.url}/plan/plan%2Flive`)).text();
    expect(page).toContain('Open changes');

    const proposes = (id: string, words: string) =>
      readFileSync(join(root, 'changes', `${id}.md`), 'utf8').includes(words);
    const accepted = ids.find((id) => proposes(id, 'as suggested')) ?? '';
    const rejected = ids.find((id) => proposes(id, 'another idea')) ?? '';
    expect((await post('accept', { changeId: accepted })).status).toBe(200);
    expect(planText()).toContain('Beta, as suggested.');
    expect(existsSync(join(root, 'changes', `${accepted}.md`))).toBe(false);

    // The other suggestion was written against the same revision, so it can no longer apply.
    expect((await post('accept', { changeId: rejected })).status).toBe(409);
    expect((await post('reject', { changeId: rejected, reason: '' })).status).toBe(400);
    expect((await post('reject', { changeId: rejected, reason: 'Superseded.' })).status).toBe(200);
    expect(readdirSync(join(root, 'changes', 'abandoned'))[0]).toContain(rejected);
  });
});
