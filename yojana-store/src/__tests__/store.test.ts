import { afterAll, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { YojanaEventInput } from '@cntxt-labs/yojana-core';
import { runStoreContract } from '../contract-suite.ts';
import { FileStore } from '../file-store.ts';
import { MemoryStore } from '../memory-store.ts';

const root = mkdtempSync(join(tmpdir(), 'yojana-store-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
const freshPath = () => join(root, `case-${++counter}`, 'log.jsonl');

runStoreContract('memory', () => {
  const store = new MemoryStore();
  return { store, reopen: () => store };
});

runStoreContract('file', () => {
  const path = freshPath();
  return { store: new FileStore({ path }), reopen: () => new FileStore({ path }) };
});

const event: YojanaEventInput = {
  type: 'status-changed',
  planId: 'plan/x',
  to: 'accepted',
  reason: 'r',
};

async function logWith(count: number): Promise<string> {
  const path = freshPath();
  const store = new FileStore({ path });
  await store.open();
  for (let i = 0; i < count; i++) await store.append(event, 'a');
  await store.close();
  return path;
}

describe('FileStore: corruption', () => {
  test('one JSON event per line, newline-terminated', async () => {
    const path = await logWith(2);
    const lines = readFileSync(path, 'utf8').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ seq: 2, type: 'status-changed' });
  });

  test('a torn final write is reported with its seq; the good prefix stays readable', async () => {
    const path = await logWith(2);
    appendFileSync(path, '{"seq":3,"type":"status-ch');
    const store = new FileStore({ path });
    expect(await store.open()).toEqual({ status: 'corrupt', source: path, atSeq: 3 });
    expect((await store.events()).map((e) => e.seq)).toEqual([1, 2]);
    await expect(store.append(event, 'a')).rejects.toMatchObject({ code: 'STORE_CORRUPT' });
  });

  test('a gap in seqs is corruption, not something to skip over', async () => {
    const path = await logWith(1);
    appendFileSync(path, `${JSON.stringify({ ...event, seq: 3, at: 0, actor: 'a' })}\n`);
    expect(await new FileStore({ path }).open()).toMatchObject({ status: 'corrupt', atSeq: 2 });
  });

  test('garbage in the middle stops reading there', async () => {
    const path = await logWith(1);
    appendFileSync(path, 'not json\n');
    appendFileSync(path, `${JSON.stringify({ ...event, seq: 2, at: 0, actor: 'a' })}\n`);
    const reopened = new FileStore({ path });
    expect(await reopened.open()).toMatchObject({ status: 'corrupt', atSeq: 2 });
    expect(await reopened.head()).toBe(1);
  });

  test('repair keeps good events, quarantines the tail, and allows appends again', async () => {
    const path = await logWith(2);
    appendFileSync(path, 'torn');
    const store = new FileStore({ path, now: () => 1234 });
    await store.open();
    const result = await store.repair();
    expect(result).toEqual({ kept: 2, quarantined: `${path}.corrupt-1234` });
    expect(readFileSync(`${path}.corrupt-1234`, 'utf8')).toBe('torn');
    expect((await store.append(event, 'a')).seq).toBe(3);

    const reopened = new FileStore({ path });
    expect(await reopened.open()).toEqual({ status: 'ok' });
    expect(await reopened.head()).toBe(3);
  });

  test('repair on a healthy log changes nothing', async () => {
    const path = await logWith(1);
    const before = readFileSync(path, 'utf8');
    const store = new FileStore({ path });
    await store.open();
    expect(await store.repair()).toEqual({ kept: 1, quarantined: undefined });
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readdirSync(join(path, '..'))).toEqual(['log.jsonl']);
  });
});
