import { describe, expect, test } from 'bun:test';
import type { StorePort, YojanaEventInput } from '@cntxt-labs/yojana-core';

/**
 * The StorePort contract. Every backend runs this suite unchanged; nothing in it may branch on
 * which backend it is testing. `make` returns a fresh, empty store and a way to get a second
 * handle on the same log (a new instance for durable backends, the same one for memory).
 */
export interface StoreFixture {
  readonly store: StorePort;
  reopen(): StorePort;
}

const sample = (n: number): YojanaEventInput => ({
  type: 'status-changed',
  planId: 'plan/x',
  to: 'accepted',
  reason: `reason ${n}`,
});

export function runStoreContract(name: string, make: () => StoreFixture): void {
  describe(`StorePort contract: ${name}`, () => {
    test('a new store is empty and opens ok', async () => {
      const { store } = make();
      expect(await store.open()).toEqual({ status: 'ok' });
      expect(await store.head()).toBe(0);
      expect(await store.events()).toEqual([]);
    });

    test('append assigns contiguous seqs from 1 and stamps time and actor', async () => {
      const { store } = make();
      await store.open();
      const first = await store.append(sample(1), 'alice');
      const second = await store.append(sample(2), 'bob');
      expect([first.seq, second.seq]).toEqual([1, 2]);
      expect(first).toMatchObject({ ...sample(1), actor: 'alice' });
      expect(typeof first.at).toBe('number');
      expect(await store.head()).toBe(2);
    });

    test('events pages by afterSeq and limit, in order', async () => {
      const { store } = make();
      await store.open();
      for (let i = 1; i <= 5; i++) await store.append(sample(i), 'a');
      expect((await store.events()).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
      expect((await store.events(2)).map((e) => e.seq)).toEqual([3, 4, 5]);
      expect((await store.events(1, 2)).map((e) => e.seq)).toEqual([2, 3]);
      expect(await store.events(5)).toEqual([]);
    });

    test('the log survives close and reopen unchanged', async () => {
      const fixture = make();
      await fixture.store.open();
      await fixture.store.append(sample(1), 'a');
      await fixture.store.append(sample(2), 'a');
      const before = await fixture.store.events();
      await fixture.store.close();

      const again = fixture.reopen();
      expect(await again.open()).toEqual({ status: 'ok' });
      expect(await again.events()).toEqual(before);
      expect((await again.append(sample(3), 'a')).seq).toBe(3);
    });

    test('a closed store refuses reads and writes with STORE_CLOSED', async () => {
      const { store } = make();
      await expect(store.append(sample(1), 'a')).rejects.toMatchObject({ code: 'STORE_CLOSED' });
      await store.open();
      await store.close();
      await expect(store.events()).rejects.toMatchObject({ code: 'STORE_CLOSED' });
    });
  });
}
