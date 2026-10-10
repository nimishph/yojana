import { describe, expect, test } from 'bun:test';
import { YojanaError } from '@cntxt-labs/yojana-core';
import { ChecklistWorkLink } from '../checklist.ts';

function memoryStorage(initialFiles: Record<string, string>) {
  const fileMap = new Map<string, string>(Object.entries(initialFiles));
  return {
    fileMap,
    readFile: (path: string) => {
      const content = fileMap.get(path);
      if (content === undefined) {
        throw new YojanaError('FILE_NOT_FOUND', `file not found: ${path}`);
      }
      return content;
    },
    writeFile: (path: string, content: string) => {
      fileMap.set(path, content);
    },
    listFiles: () => [...fileMap.keys()],
  };
}

const SAMPLE_PLAN = `---
id: plan/demo
title: Demo Plan
---

# Demo Plan

## Requirement: User Authentication {#req-auth}

Users must authenticate before accessing the API.

### Actions
- [x] Create password hashing utility {#act-hash}
- [ ] Implement JWT token issuance {#act-jwt}
- [x] Rate limit login attempts {#act-ratelimit}

## Requirement: Database Persistence {#req-db}

All records must be persisted safely.

- [x] PostgreSQL migration scripts {#act-migration}
- [x] Read replica configuration {#act-replica}

## Requirement: Email Notifications {#req-email}

Send transactional emails on events.

- [ ] Configure SMTP transport
- [ ] Create welcome template
`;

describe('ChecklistWorkLink.get', () => {
  test('items with - [x] count as closed and - [ ] as open', async () => {
    const storage = memoryStorage({ 'plans/demo.md': SAMPLE_PLAN });
    const cl = new ChecklistWorkLink(storage);

    const lookup = await cl.get(['act-hash', 'act-jwt', 'act-ratelimit']);
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;

    expect(lookup.items).toEqual([
      {
        id: 'act-hash',
        title: 'Create password hashing utility',
        state: 'closed',
        rawState: '[x]',
      },
      { id: 'act-jwt', title: 'Implement JWT token issuance', state: 'open', rawState: '[ ]' },
      { id: 'act-ratelimit', title: 'Rate limit login attempts', state: 'closed', rawState: '[x]' },
    ]);
  });

  test('requirement progress is derived from its checklist items', async () => {
    const storage = memoryStorage({ 'plans/demo.md': SAMPLE_PLAN });
    const cl = new ChecklistWorkLink(storage);

    // req-auth has 2 of 3 closed -> in-progress
    // req-db has 2 of 2 closed -> closed (all-done)
    // req-email has 0 of 2 closed -> open
    const lookup = await cl.get(['req-auth', 'req-db', 'req-email', 'nonexistent']);
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;

    expect(lookup.items).toEqual([
      { id: 'req-auth', title: 'User Authentication', state: 'in-progress', rawState: '2/3 done' },
      { id: 'req-db', title: 'Database Persistence', state: 'closed', rawState: 'all-done' },
      { id: 'req-email', title: 'Email Notifications', state: 'open', rawState: '0/2 done' },
      { id: 'nonexistent', title: '', state: 'missing' },
    ]);
  });

  test('empty ids list returns ok without reading files', async () => {
    const storage = memoryStorage({});
    const cl = new ChecklistWorkLink(storage);
    expect(await cl.get([])).toEqual({ ok: true, items: [] });
  });
});

describe('ChecklistWorkLink.children', () => {
  test('returns checklist items under requirement', async () => {
    const storage = memoryStorage({ 'plans/demo.md': SAMPLE_PLAN });
    const cl = new ChecklistWorkLink(storage);

    const result = await cl.children('req-auth');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.items).toEqual([
      {
        id: 'act-hash',
        title: 'Create password hashing utility',
        state: 'closed',
        rawState: '[x]',
      },
      { id: 'act-jwt', title: 'Implement JWT token issuance', state: 'open', rawState: '[ ]' },
      { id: 'act-ratelimit', title: 'Rate limit login attempts', state: 'closed', rawState: '[x]' },
    ]);
  });

  test('generates numbered ids for checklist items without explicit id attributes', async () => {
    const storage = memoryStorage({ 'plans/demo.md': SAMPLE_PLAN });
    const cl = new ChecklistWorkLink(storage);

    const result = await cl.children('req-email');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.items).toEqual([
      { id: 'req-email.1', title: 'Configure SMTP transport', state: 'open', rawState: '[ ]' },
      { id: 'req-email.2', title: 'Create welcome template', state: 'open', rawState: '[ ]' },
    ]);
  });

  test('returns empty items for unknown requirement', async () => {
    const storage = memoryStorage({ 'plans/demo.md': SAMPLE_PLAN });
    const cl = new ChecklistWorkLink(storage);

    expect(await cl.children('unknown')).toEqual({ ok: true, items: [] });
  });
});

describe('ChecklistWorkLink.close and reopen', () => {
  test('close toggles - [ ] to - [x] in the file', async () => {
    const storage = memoryStorage({ 'plans/demo.md': SAMPLE_PLAN });
    const cl = new ChecklistWorkLink(storage);

    const result = await cl.close('act-jwt', 'Implemented in PR');
    expect(result).toEqual({ ok: true });

    const updated = storage.fileMap.get('plans/demo.md') ?? '';
    expect(updated).toContain('- [x] Implement JWT token issuance {#act-jwt}');

    // Subsequent get shows it as closed
    const lookup = await cl.get(['act-jwt']);
    expect(lookup).toEqual({
      ok: true,
      items: [
        { id: 'act-jwt', title: 'Implement JWT token issuance', state: 'closed', rawState: '[x]' },
      ],
    });
  });

  test('reopen toggles - [x] to - [ ] in the file', async () => {
    const storage = memoryStorage({ 'plans/demo.md': SAMPLE_PLAN });
    const cl = new ChecklistWorkLink(storage);

    const result = await cl.reopen('act-hash', 'Found salt flaw');
    expect(result).toEqual({ ok: true });

    const updated = storage.fileMap.get('plans/demo.md') ?? '';
    expect(updated).toContain('- [ ] Create password hashing utility {#act-hash}');
  });

  test('closing requirement toggles all its items', async () => {
    const storage = memoryStorage({ 'plans/demo.md': SAMPLE_PLAN });
    const cl = new ChecklistWorkLink(storage);

    const result = await cl.close('req-email', 'Finished email setup');
    expect(result).toEqual({ ok: true });

    const updated = storage.fileMap.get('plans/demo.md') ?? '';
    expect(updated).toContain('- [x] Configure SMTP transport');
    expect(updated).toContain('- [x] Create welcome template');
  });

  test('reports error when closing unknown item', async () => {
    const storage = memoryStorage({ 'plans/demo.md': SAMPLE_PLAN });
    const cl = new ChecklistWorkLink(storage);

    expect(await cl.close('not-there', 'reason')).toEqual({
      ok: false,
      error: 'checklist has no item not-there',
    });
  });
});

describe('ChecklistWorkLink.create', () => {
  test('appends new checklist item under requirement actions', async () => {
    const storage = memoryStorage({ 'plans/demo.md': SAMPLE_PLAN });
    const cl = new ChecklistWorkLink(storage);

    const created = await cl.create({
      title: 'Refresh token endpoint',
      parent: 'req-auth',
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.id).toContain('act-refresh-token');

    const updated = storage.fileMap.get('plans/demo.md') ?? '';
    expect(updated).toContain(`- [ ] Refresh token endpoint {#${created.id}}`);

    // Verify it is discoverable via children
    const kids = await cl.children('req-auth');
    expect(kids.ok).toBe(true);
    if (!kids.ok) return;
    expect(kids.items.some((i) => i.id === created.id)).toBe(true);
  });
});
