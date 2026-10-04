import { describe, expect, test } from 'bun:test';
import type { YojanaEvent, YojanaEventInput } from '../events.ts';
import { approvalOf, foldLog, isAnnotationOutdated, openAnomalies, planHeads } from '../fold.ts';
import type { Requirement } from '../model.ts';
import { requirementRevision } from '../revision.ts';

const req = (id: string, text: string): Requirement => ({
  id,
  title: id,
  text,
  revision: requirementRevision({ id, title: id, text, claims: [] }),
  claims: [],
});

function log(...inputs: YojanaEventInput[]): YojanaEvent[] {
  return inputs.map((input, i) => ({
    ...input,
    eventId: `e_${i + 1}`,
    seq: i + 1,
    at: 1000 + i,
    actor: 'tester',
  }));
}

const a1 = req('a', 'one');
const a2 = req('a', 'two');
const b1 = req('b', 'bee');

describe('foldLog', () => {
  test('revisions build heads; a modify on the current base is clean', () => {
    const state = foldLog(
      log(
        { type: 'revision-recorded', planId: 'p', requirement: a1 },
        { type: 'revision-recorded', planId: 'p', requirement: b1 },
        { type: 'revision-recorded', planId: 'p', requirement: a2, base: a1.revision },
      ),
    );
    expect([...planHeads(state, 'p')]).toEqual([
      ['a', a2.revision],
      ['b', b1.revision],
    ]);
    expect(state.anomalies).toEqual([]);
    expect(state.head).toBe(3);
  });

  test('a revision recorded on a stale base is applied and reported', () => {
    const state = foldLog(
      log(
        { type: 'revision-recorded', planId: 'p', requirement: a1 },
        { type: 'revision-recorded', planId: 'p', requirement: a2, base: 'r_stale' },
      ),
    );
    expect(planHeads(state, 'p').get('a')).toBe(a2.revision);
    expect(state.anomalies.map((x) => [x.seq, x.code])).toEqual([[2, 'STALE_BASE']]);
  });

  test('archiving a change applies its deltas; abandoning keeps the reason', () => {
    const state = foldLog(
      log(
        { type: 'revision-recorded', planId: 'p', requirement: a1 },
        {
          type: 'change-opened',
          change: {
            id: 'c1',
            planId: 'p',
            title: 'edit a, add b',
            deltas: [
              { op: 'modify', requirement: a2, base: a1.revision },
              { op: 'add', requirement: b1 },
            ],
          },
        },
        { type: 'change-opened', change: { id: 'c2', planId: 'p', title: 'drop', deltas: [] } },
        { type: 'change-archived', changeId: 'c1' },
        { type: 'change-abandoned', changeId: 'c2', reason: 'superseded by c1' },
      ),
    );
    expect([...planHeads(state, 'p').keys()]).toEqual(['a', 'b']);
    expect(planHeads(state, 'p').get('a')).toBe(a2.revision);
    expect(state.changes.get('c1')).toMatchObject({ status: 'archived', closedSeq: 4 });
    expect(state.changes.get('c2')).toMatchObject({
      status: 'abandoned',
      reason: 'superseded by c1',
    });
    expect(state.anomalies).toEqual([]);
  });

  test('closing a change twice, or an unknown one, is an anomaly', () => {
    const state = foldLog(
      log(
        { type: 'change-opened', change: { id: 'c', planId: 'p', title: 't', deltas: [] } },
        { type: 'change-archived', changeId: 'c' },
        { type: 'change-abandoned', changeId: 'c', reason: 'late' },
        { type: 'change-archived', changeId: 'nope' },
      ),
    );
    expect(state.changes.get('c')?.status).toBe('archived');
    expect(state.anomalies.map((x) => x.code)).toEqual(['CHANGE_NOT_OPEN', 'CHANGE_NOT_OPEN']);
  });

  test('status changes keep their history', () => {
    const state = foldLog(
      log(
        { type: 'status-changed', planId: 'p', to: 'accepted', reason: 'reviewed' },
        { type: 'status-changed', planId: 'p', to: 'in-progress', reason: 'beads filed' },
      ),
    );
    const plan = state.plans.get('p');
    expect(plan?.status).toBe('in-progress');
    expect(plan?.statusHistory.map((s) => [s.to, s.reason, s.actor])).toEqual([
      ['accepted', 'reviewed', 'tester'],
      ['in-progress', 'beads filed', 'tester'],
    ]);
  });

  test('annotations go outdated when their requirement moves on', () => {
    const annotation = {
      id: 'n1',
      requirement: 'a',
      revision: a1.revision,
      author: 'rev',
      body: 'why npx?',
    };
    const events = log(
      { type: 'revision-recorded', planId: 'p', requirement: a1 },
      { type: 'annotation-added', planId: 'p', annotation },
    );
    const before = foldLog(events);
    expect(isAnnotationOutdated(before, 'p', annotation)).toBe(false);
    const after = foldLog(
      [
        {
          type: 'revision-recorded',
          planId: 'p',
          requirement: a2,
          base: a1.revision,
          eventId: 'e_3',
          seq: 3,
          at: 0,
          actor: 't',
        },
      ],
      before,
    );
    expect(isAnnotationOutdated(after, 'p', annotation)).toBe(true);
  });

  test('unknown event types and out-of-order seqs are reported, not dropped silently', () => {
    const unknown = {
      type: 'from-the-future',
      seq: 1,
      at: 0,
      actor: 't',
    } as unknown as YojanaEvent;
    const state = foldLog([
      unknown,
      {
        type: 'status-changed',
        planId: 'p',
        to: 'accepted',
        reason: 'r',
        eventId: 'e_x',
        seq: 1,
        at: 0,
        actor: 't',
      },
    ]);
    expect(state.anomalies.map((x) => [x.seq, x.code])).toEqual([
      [1, 'UNKNOWN_EVENT'],
      [1, 'OUT_OF_ORDER'],
    ]);
    expect(state.plans.size).toBe(0);
  });
});

/** Small deterministic PRNG so failures reproduce from the seed. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomLog(seed: number, length: number): YojanaEvent[] {
  const rand = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
  const plans = ['p1', 'p2'];
  const ids = ['a', 'b', 'c'];
  const texts = ['x', 'y', 'z', 'w'];
  const changeIds: string[] = [];
  const inputs: YojanaEventInput[] = [];

  for (let i = 0; i < length; i++) {
    const roll = rand();
    const r = req(pick(ids), pick(texts));
    if (roll < 0.35) {
      const base = rand() < 0.5 ? undefined : req(r.id, pick(texts)).revision;
      inputs.push({ type: 'revision-recorded', planId: pick(plans), requirement: r, base });
    } else if (roll < 0.45) {
      inputs.push({ type: 'requirement-removed', planId: pick(plans), id: r.id, base: r.revision });
    } else if (roll < 0.6) {
      const id = `c${i}`;
      changeIds.push(id);
      inputs.push({
        type: 'change-opened',
        change: { id, planId: pick(plans), title: id, deltas: [{ op: 'add', requirement: r }] },
      });
    } else if (roll < 0.75 && changeIds.length > 0) {
      inputs.push(
        rand() < 0.5
          ? { type: 'change-archived', changeId: pick(changeIds) }
          : { type: 'change-abandoned', changeId: pick(changeIds), reason: 'r' },
      );
    } else if (roll < 0.9) {
      inputs.push({
        type: 'status-changed',
        planId: pick(plans),
        to: pick(['draft', 'accepted', 'realized'] as const),
        reason: 'r',
      });
    } else {
      inputs.push({
        type: 'annotation-added',
        planId: pick(plans),
        annotation: {
          id: `n${i}`,
          requirement: r.id,
          revision: r.revision,
          author: 'a',
          body: 'b',
        },
      });
    }
  }
  return log(...inputs);
}

describe('foldLog: properties over random logs', () => {
  const seeds = Array.from({ length: 50 }, (_, i) => i + 1);

  test.each(seeds)(
    'seed %i: replay is deterministic, batch-independent and survives JSONL',
    (seed) => {
      const events = randomLog(seed, 60);
      const once = foldLog(events);
      expect(foldLog(events)).toEqual(once);

      const cut = Math.floor(mulberry32(seed * 7)() * events.length);
      expect(foldLog(events.slice(cut), foldLog(events.slice(0, cut)))).toEqual(once);

      const viaJsonl = events
        .map((e) => JSON.stringify(e))
        .join('\n')
        .split('\n')
        .map((line) => JSON.parse(line) as YojanaEvent);
      expect(foldLog(viaJsonl)).toEqual(once);
    },
  );
});

describe('foldLog: concurrent edits after a merge', () => {
  const b2 = req('b', 'bee two');

  test('two edits written against the same revision leave the requirement contested', () => {
    // Both branches started from a1 and edited a; git kept both lines.
    const state = foldLog(
      log(
        { type: 'revision-recorded', planId: 'p', requirement: a1 },
        { type: 'revision-recorded', planId: 'p', requirement: a2, base: a1.revision },
        {
          type: 'revision-recorded',
          planId: 'p',
          requirement: req('a', 'three'),
          base: a1.revision,
        },
      ),
    );
    expect(state.plans.get('p')?.contested.get('a')).toEqual([
      a2.revision,
      req('a', 'three').revision,
    ]);
    expect(state.anomalies.map((x) => x.code)).toEqual(['STALE_BASE']);
  });

  test('an edit written against the head settles it', () => {
    const three = req('a', 'three');
    const settled = req('a', 'settled');
    const state = foldLog(
      log(
        { type: 'revision-recorded', planId: 'p', requirement: a1 },
        { type: 'revision-recorded', planId: 'p', requirement: a2, base: a1.revision },
        { type: 'revision-recorded', planId: 'p', requirement: three, base: a1.revision },
        { type: 'revision-recorded', planId: 'p', requirement: settled, base: three.revision },
      ),
    );
    expect(state.plans.get('p')?.contested.size).toBe(0);
    expect(planHeads(state, 'p').get('a')).toBe(settled.revision);
    // The collision stays in the history, marked settled by the edit that resolved it.
    expect(state.anomalies).toMatchObject([{ code: 'STALE_BASE', requirement: 'a', settledBy: 4 }]);
    expect(openAnomalies(state)).toEqual([]);
  });

  test('edits to different requirements on two branches merge with no anomaly', () => {
    const state = foldLog(
      log(
        { type: 'revision-recorded', planId: 'p', requirement: a1 },
        { type: 'revision-recorded', planId: 'p', requirement: b1 },
        { type: 'revision-recorded', planId: 'p', requirement: a2, base: a1.revision },
        { type: 'revision-recorded', planId: 'p', requirement: b2, base: b1.revision },
      ),
    );
    expect(state.anomalies).toEqual([]);
    expect(state.plans.get('p')?.contested.size).toBe(0);
  });
});

describe('status proposals and approvals', () => {
  test('a proposal is finalized by the status change naming it, or declined', () => {
    const state = foldLog(
      log(
        { type: 'status-proposed', planId: 'p', to: 'accepted', reason: 'ready' },
        { type: 'status-changed', planId: 'p', to: 'accepted', reason: 'ready', proposal: 'e_1' },
        { type: 'status-proposed', planId: 'p', to: 'realized', reason: 'done' },
        { type: 'status-declined', proposalId: 'e_3', reason: 'not yet' },
      ),
    );
    expect(state.plans.get('p')?.status).toBe('accepted');
    expect([...state.proposals.values()]).toMatchObject([
      { id: 'e_1', status: 'accepted', decidedBy: 'tester' },
      { id: 'e_3', status: 'declined', outcome: 'not yet' },
    ]);
    expect(openAnomalies(state)).toEqual([]);
  });

  test('deciding a proposal twice, or one that does not exist, is an anomaly', () => {
    const state = foldLog(
      log(
        { type: 'status-proposed', planId: 'p', to: 'accepted', reason: 'ready' },
        { type: 'status-declined', proposalId: 'e_1', reason: 'no' },
        { type: 'status-changed', planId: 'p', to: 'accepted', reason: 'yes', proposal: 'e_1' },
        { type: 'status-declined', proposalId: 'e_9', reason: 'no' },
      ),
    );
    // The move itself is recorded: the log is the source of truth.
    expect(state.plans.get('p')?.status).toBe('accepted');
    expect(openAnomalies(state).map((a) => a.code)).toEqual([
      'PROPOSAL_OUT_OF_STEP',
      'PROPOSAL_OUT_OF_STEP',
    ]);
  });

  test('the latest approval of a requirement is kept, with its revision', () => {
    const state = foldLog(
      log(
        { type: 'revision-recorded', planId: 'p', requirement: a1 },
        { type: 'requirement-approved', planId: 'p', requirement: 'a', revision: a1.revision },
        { type: 'revision-recorded', planId: 'p', requirement: a2, base: a1.revision },
      ),
    );
    const plan = state.plans.get('p');
    expect(plan && approvalOf(plan, 'a')).toEqual({
      revision: a1.revision,
      by: 'tester',
      at: 1001,
      stale: true,
    });
    expect(plan && approvalOf(plan, 'b')).toBeUndefined();
  });
});
