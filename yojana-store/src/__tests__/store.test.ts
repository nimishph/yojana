import { afterAll, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { YojanaEventInput } from '@cntxt-labs/yojana-core';
import { FileBaseStore } from '../base-store.ts';
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
  test('one JSON event per line, with an event id and no stored position', async () => {
    const path = await logWith(2);
    const lines = readFileSync(path, 'utf8').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    const stored = JSON.parse(lines[1] ?? '');
    expect(stored).toMatchObject({ type: 'status-changed', eventId: expect.stringMatching(/^e_/) });
    expect(stored.seq).toBeUndefined();
  });

  test('a log merged line by line from two branches reads in file order', async () => {
    // Common history, then each branch appends one event; git merge=union keeps both lines.
    const base = await logWith(1);
    const common = readFileSync(base, 'utf8');
    const branch = async (reason: string, actor: string) => {
      const path = freshPath();
      const store = new FileStore({ path });
      await store.open();
      await store.append({ ...event, reason }, actor);
      return readFileSync(path, 'utf8');
    };
    const ours = await branch('ours', 'alice');
    const theirs = await branch('theirs', 'bob');
    const merged = freshPath();
    mkdirSync(join(merged, '..'), { recursive: true });
    writeFileSync(merged, common + ours + theirs);

    const store = new FileStore({ path: merged });
    expect(await store.open()).toEqual({ status: 'ok' });
    const events = await store.events();
    expect(events.map((e) => [e.seq, e.actor])).toEqual([
      [1, 'a'],
      [2, 'alice'],
      [3, 'bob'],
    ]);
    expect((await store.append(event, 'carol')).seq).toBe(4);
  });

  test('a line written before event ids existed still reads, its stored seq ignored', async () => {
    const path = freshPath();
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ ...event, seq: 7, at: 5, actor: 'old' })}\n`);
    const store = new FileStore({ path });
    expect(await store.open()).toEqual({ status: 'ok' });
    expect(await store.events()).toMatchObject([
      { seq: 1, actor: 'old', eventId: expect.stringMatching(/^e_/) },
    ]);
  });

  test('a torn final write is reported with its seq; the good prefix stays readable', async () => {
    const path = await logWith(2);
    appendFileSync(path, '{"seq":3,"type":"status-ch');
    const store = new FileStore({ path });
    expect(await store.open()).toEqual({ status: 'corrupt', source: path, atSeq: 3 });
    expect((await store.events()).map((e) => e.seq)).toEqual([1, 2]);
    await expect(store.append(event, 'a')).rejects.toMatchObject({ code: 'STORE_CORRUPT' });
  });

  test('the same event twice is corruption, not something to skip over', async () => {
    const path = await logWith(1);
    const [line] = readFileSync(path, 'utf8').split('\n');
    appendFileSync(path, `${line}\n`);
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

describe('FileBaseStore', () => {
  const dir = () => join(root, `bases-${++counter}`);

  test('round-trips, one line per requirement, sorted', async () => {
    const store = new FileBaseStore({ dir: dir() });
    await store.set({ planId: 'plan/x', status: 'accepted', revisions: { b: 'r_2', a: 'r_1' } });
    expect(await store.get('plan/x')).toEqual({
      planId: 'plan/x',
      status: 'accepted',
      revisions: { a: 'r_1', b: 'r_2' },
    });
    const text = readFileSync(join(store.dir, 'plan%2Fx.jsonl'), 'utf8');
    expect(text.trim().split('\n')).toHaveLength(3);
  });

  test('reads a union-merged file: a repeated line, last one wins', async () => {
    const store = new FileBaseStore({ dir: dir() });
    mkdirSync(store.dir, { recursive: true });
    writeFileSync(
      join(store.dir, 'plan%2Fx.jsonl'),
      [
        '{"planId":"plan/x","status":"accepted"}',
        '{"id":"a","revision":"r_ours"}',
        '{"id":"a","revision":"r_theirs"}',
        '{"id":"b","revision":"r_b"}',
      ].join('\n'),
    );
    expect((await store.get('plan/x'))?.revisions).toEqual({ a: 'r_theirs', b: 'r_b' });
  });

  test('reads the earlier JSON format and replaces it on the next write', async () => {
    const store = new FileBaseStore({ dir: dir() });
    mkdirSync(store.dir, { recursive: true });
    const legacy = join(store.dir, 'plan%2Fx.json');
    writeFileSync(
      legacy,
      JSON.stringify({ planId: 'plan/x', status: 'draft', revisions: { a: 'r_1' } }),
    );
    const base = await store.get('plan/x');
    expect(base?.revisions).toEqual({ a: 'r_1' });
    if (base !== undefined) await store.set(base);
    expect(readdirSync(store.dir)).toEqual(['plan%2Fx.jsonl']);
  });

  test('git conflict markers are reported, not guessed around', async () => {
    const store = new FileBaseStore({ dir: dir() });
    mkdirSync(store.dir, { recursive: true });
    writeFileSync(join(store.dir, 'plan%2Fx.jsonl'), '<<<<<<< HEAD\n{"planId":"plan/x"}\n');
    await expect(store.get('plan/x')).rejects.toMatchObject({ code: 'BASE_UNREADABLE' });
  });
});
