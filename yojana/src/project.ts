import {
  type Annotation,
  type ChangeState,
  type ClaimResult,
  type Delta,
  findBaseConflicts,
  foldLog,
  isAnnotationOutdated,
  openAnomalies,
  type Plan,
  type PlanState,
  type PlanStatus,
  planHeads,
  type Requirement,
  type YojanaEvent,
} from '@cntxt-labs/yojana-core';
import type { PlanReport } from './status.ts';

/**
 * The projector: yojana's state for one plan, as content for patra's `review-document` template.
 * yojana keeps the domain; how it looks and how people act on it are patra's (ADR-001). The output
 * is plain data shaped by the template's content schema; nothing here knows about HTML.
 *
 * What a person needs to see first is computed here, not in the template: each requirement's
 * health from its claim results, the tags the filters work on, the flags that ask for a decision
 * (close a work item whose claims all hold; reopen one closed while a claim is violated), and
 * activity told as sentences.
 */

type Intent = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

interface Chip {
  readonly label: string;
  readonly intent?: Intent;
}

type Formatted =
  | { readonly kind: 'markdown'; readonly source: string; readonly marks?: readonly Mark[] }
  | { readonly kind: 'diff'; readonly before: string; readonly after: string };

interface Mark {
  readonly text: string;
  readonly id: string;
}

interface Button {
  readonly action: string;
  readonly label: string;
  readonly item?: string;
  readonly decision?: string;
  readonly primary?: boolean;
}

export interface ReviewSection {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly health: Intent;
  readonly note?: string;
  readonly tags: readonly string[];
  readonly properties: readonly Chip[];
  readonly body: Formatted;
  readonly proposed?: Formatted;
  readonly evidence: readonly Chip[];
  readonly flags?: readonly { text: string; intent?: Intent; buttons?: readonly Button[] }[];
  readonly editable: { readonly title: string; readonly text: string };
}

interface Reply {
  readonly author: string;
  readonly agent?: boolean;
  readonly when: string;
  readonly body: string;
}

export interface ReviewThread extends Reply {
  readonly id: string;
  readonly section: string;
  readonly mark?: string;
  readonly quote?: string;
  readonly outdated: boolean;
  readonly replies: readonly Reply[];
}

export interface ReviewChange {
  readonly id: string;
  readonly title: string;
  readonly author?: string;
  readonly when: string;
  readonly status: Chip;
  readonly applies: boolean;
  readonly diffs: readonly { section: string; label: string; diff: Formatted }[];
}

export interface ReviewActivity {
  readonly id: string;
  readonly who: string;
  readonly kind: 'person' | 'agent' | 'you';
  readonly what: string;
  readonly when: string;
}

/** Content for patra's `review-document` template (see its content.schema.json). */
export interface ReviewDocument {
  readonly document: {
    readonly id: string;
    readonly title: string;
    readonly crumbs?: string;
    readonly status: Chip;
    readonly metrics: readonly (Chip & { meter?: { value: number; max: number } })[];
    readonly mode: 'read' | 'suggest' | 'edit';
    readonly intro?: Formatted;
    readonly banner?: Chip;
    readonly source?: string;
    readonly freshness: string;
  };
  readonly filters: readonly { id: string; label: string; count: number; active?: boolean }[];
  readonly sections: readonly ReviewSection[];
  readonly threads: readonly ReviewThread[];
  readonly changes: readonly ReviewChange[];
  readonly activity: readonly ReviewActivity[];
}

export interface ProjectOptions {
  readonly events: readonly YojanaEvent[];
  readonly planId: string;
  /** The plan as its file reads, for the title, the introduction and the source path. */
  readonly plan?: Plan | undefined;
  readonly report?: PlanReport | undefined;
  /** Claim results; empty when claims were not checked. */
  readonly checks: readonly ClaimResult[];
  /** When `checks` were taken; undefined when they were not. */
  readonly checkedAt?: number | undefined;
  readonly now: number;
  readonly mode: 'read' | 'suggest' | 'edit';
  /** The repository's name, shown before the plan's path. */
  readonly repository?: string | undefined;
  /** The person looking: their own activity reads as "you". */
  readonly you?: string | undefined;
  /** Actors that are agents, not people. */
  readonly agents?: readonly string[] | undefined;
}

/** Recent events shown in the activity rail. */
export const ACTIVITY_LIMIT = 12;
const DEFAULT_AGENTS: readonly string[] = ['claude'];
const MINUTE_MS = 60_000;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;

const STATUS_INTENT: Readonly<Record<PlanStatus, Intent>> = {
  draft: 'neutral',
  accepted: 'primary',
  'in-progress': 'primary',
  realized: 'success',
  superseded: 'neutral',
  abandoned: 'neutral',
};

const OUTCOME_INTENT: Readonly<Record<ClaimResult['outcome'], Intent>> = {
  holds: 'success',
  violated: 'danger',
  unverifiable: 'warning',
};

/** Time since `at`, short: "just now", "5m", "3h", "2d". */
export function ago(at: number, now: number): string {
  const minutes = Math.round((now - at) / MINUTE_MS);
  if (minutes < 1) return 'just now';
  if (minutes < MINUTES_PER_HOUR) return `${minutes}m`;
  if (minutes < MINUTES_PER_DAY) return `${Math.round(minutes / MINUTES_PER_HOUR)}h`;
  return `${Math.round(minutes / MINUTES_PER_DAY)}d`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Violated beats everything; all holding is success; anything left unchecked is a warning. */
function healthOf(results: readonly ClaimResult[]): Intent {
  if (results.some((r) => r.outcome === 'violated')) return 'danger';
  if (results.length > 0 && results.every((r) => r.outcome === 'holds')) return 'success';
  return results.length > 0 ? 'warning' : 'neutral';
}

function deltaTarget(delta: Delta): string {
  return delta.op === 'remove' ? delta.id : delta.requirement.id;
}

/**
 * Number the comments that quote live text, in reading order: section by section, and within a
 * section by where the quote sits in the text. Outdated comments and quotes no longer in the text
 * get no number, since there is nothing to point at.
 */
function numberMarks(state: ReturnType<typeof foldLog>, plan: PlanState): Map<string, string> {
  const numbers = new Map<string, string>();
  let next = 0;
  for (const requirement of plan.heads.values()) {
    const quoted = plan.annotations
      .filter(
        (a) =>
          a.requirement === requirement.id &&
          a.replyTo === undefined &&
          a.quote !== undefined &&
          a.quote !== '' &&
          requirement.text.includes(a.quote) &&
          !isAnnotationOutdated(state, plan.id, a),
      )
      .map((a) => ({ a, at: requirement.text.indexOf(a.quote ?? '') }))
      .sort((x, y) => x.at - y.at);
    for (const { a } of quoted) {
      next += 1;
      numbers.set(a.id, String(next));
    }
  }
  return numbers;
}

export function projectReview(options: ProjectOptions): ReviewDocument | undefined {
  const state = foldLog(options.events);
  const plan = state.plans.get(options.planId);
  if (plan === undefined) return undefined;
  const { now, report, checks } = options;
  const agents = options.agents ?? DEFAULT_AGENTS;
  const isAgent = (actor: string) => agents.includes(actor);
  const when = (at: number | undefined) => (at === undefined ? '' : ago(at, now));

  const atOf = new Map<string, number>();
  const openedBy = new Map<string, string>();
  for (const event of options.events) {
    if (event.type === 'annotation-added') atOf.set(event.annotation.id, event.at);
    if (event.type === 'change-opened') openedBy.set(event.change.id, event.actor);
  }

  const openChanges: ChangeState[] = [...state.changes.values()]
    .filter((c) => c.status === 'open' && c.change.planId === plan.id)
    .sort((a, b) => a.openedSeq - b.openedSeq);
  const heads = planHeads(state, plan.id);
  const marks = numberMarks(state, plan);

  const sections = [...plan.heads.values()].map((r) =>
    projectSection({ state, plan, requirement: r, report, checks, openChanges, marks }),
  );

  const threads = projectThreads(plan, state, marks, atOf, isAgent, when);

  const changes: ReviewChange[] = openChanges.map((c) => {
    const applies = findBaseConflicts(heads, c.change.deltas).length === 0;
    const author = openedBy.get(c.change.id);
    return {
      id: c.change.id,
      title: c.change.title,
      ...(author === undefined ? {} : { author }),
      when: when(c.openedAt),
      status: applies
        ? { label: 'applies cleanly', intent: 'success' }
        : { label: 'no longer applies', intent: 'danger' },
      applies,
      diffs: c.change.deltas.map((d) => {
        const id = deltaTarget(d);
        const title = d.op === 'remove' ? (plan.heads.get(id)?.title ?? id) : d.requirement.title;
        return {
          section: id,
          label: `${d.op} · ${title}`,
          diff: {
            kind: 'diff',
            before: plan.heads.get(id)?.text ?? '',
            after: d.op === 'remove' ? '' : d.requirement.text,
          },
        };
      }),
    };
  });

  const count = (tag: string) => sections.filter((s) => s.tags.includes(tag)).length;
  const attention = count('attention');
  const filters = [
    {
      id: 'attention',
      label: 'Needs attention',
      count: attention,
      ...(attention > 0 ? { active: true } : {}),
    },
    { id: 'close', label: 'Close?', count: count('close') },
    { id: 'violated', label: 'Violated', count: count('violated') },
  ];

  const tally = (o: ClaimResult['outcome']) => checks.filter((c) => c.outcome === o).length;
  const progress = report?.progress;
  const file = report?.file;
  const pending =
    file?.kind === 'file'
      ? file.unrecorded.length + file.behind.length + file.conflicts.length
      : undefined;
  const metrics = [
    ...(progress !== undefined && progress.error === undefined && progress.total > 0
      ? [
          {
            label: `${progress.done}/${progress.total} work items`,
            meter: { value: progress.done, max: progress.total },
          },
        ]
      : []),
    ...(checks.length === 0
      ? [{ label: 'claims not checked', intent: 'neutral' as const }]
      : [
          { label: `${tally('holds')} hold`, intent: 'success' as const },
          ...(tally('violated') > 0
            ? [{ label: `${tally('violated')} violated`, intent: 'danger' as const }]
            : []),
          ...(tally('unverifiable') > 0
            ? [{ label: `${tally('unverifiable')} not checked`, intent: 'warning' as const }]
            : []),
        ]),
    ...(pending === undefined
      ? []
      : pending === 0
        ? [{ label: 'file in step', intent: 'success' as const }]
        : [{ label: `${plural(pending, 'pending file edit')}`, intent: 'warning' as const }]),
  ];

  const anomalies = openAnomalies(state).filter(
    (a) => a.planId === undefined || a.planId === plan.id,
  );
  const intro = options.plan?.parts.find((p) => p.kind === 'prose');
  const introText =
    intro?.kind === 'prose' ? intro.markdown.replace(/^#\s.*\n*/, '').trim() : undefined;
  const source = options.plan?.source ?? (file?.kind === 'file' ? file.source : undefined);
  const crumbs = [options.repository, source].filter((s) => s !== undefined).join(' / ');

  return {
    document: {
      id: plan.id,
      title: options.plan?.title ?? plan.id,
      ...(crumbs === '' ? {} : { crumbs }),
      status: { label: plan.status, intent: STATUS_INTENT[plan.status] },
      metrics,
      mode: options.mode,
      ...(introText === undefined || introText === ''
        ? {}
        : { intro: { kind: 'markdown', source: introText } }),
      ...(anomalies.length > 0
        ? {
            banner: {
              label: `${plural(anomalies.length, 'anomaly', 'anomalies')} in the log: ${anomalies[0]?.message ?? ''}`,
              intent: 'warning',
            },
          }
        : {}),
      ...(source === undefined ? {} : { source }),
      freshness:
        options.checkedAt === undefined
          ? 'claims not checked'
          : `claims checked ${when(options.checkedAt)}${options.checkedAt >= now - MINUTE_MS ? '' : ' ago'}`,
    },
    filters,
    sections,
    threads,
    changes,
    activity: projectActivity(options, plan, state, isAgent, when),
  };
}

function projectSection(input: {
  readonly state: ReturnType<typeof foldLog>;
  readonly plan: PlanState;
  readonly requirement: Requirement;
  readonly report: PlanReport | undefined;
  readonly checks: readonly ClaimResult[];
  readonly openChanges: readonly ChangeState[];
  readonly marks: ReadonlyMap<string, string>;
}): ReviewSection {
  const { plan, requirement: r, marks } = input;
  const results = input.checks.filter((c) => c.requirement === r.id);
  const health = healthOf(results);
  const alignment = input.report?.alignment.find((a) => a.requirement === r.id);
  const touching = input.openChanges.filter((c) =>
    c.change.deltas.some((d) => deltaTarget(d) === r.id),
  );
  const delta = touching[0]?.change.deltas.find((d) => deltaTarget(d) === r.id);
  const contested = plan.contested.has(r.id);
  const threads = plan.annotations.filter(
    (a) => a.requirement === r.id && a.replyTo === undefined,
  ).length;

  const tags: string[] = [];
  if (alignment?.mismatch === 'claims-hold-work-open') tags.push('close');
  if (health === 'danger') tags.push('violated');
  if (tags.length > 0 || touching.length > 0 || contested) tags.push('attention');

  const note = [
    alignment?.mismatch === 'claims-hold-work-open' ? 'close?' : '',
    alignment?.mismatch === 'work-closed-claims-violated' ? 'reopen?' : '',
    contested ? 'contested' : '',
    touching.length > 0 ? plural(touching.length, 'change') : '',
    threads > 0 ? plural(threads, 'thread') : '',
  ]
    .filter((s) => s !== '')
    .join(' · ');

  const items = alignment?.items ?? (r.workItems ?? []).map((id) => ({ id, state: undefined }));
  const properties: Chip[] = [
    ...items.map((i) => ({
      label: i.state === undefined ? i.id : `${i.id} · ${i.state}`,
      ...(i.state === 'closed' ? { intent: 'success' as const } : {}),
    })),
    ...(r.claims.length === 0
      ? []
      : results.length === 0
        ? [{ label: plural(r.claims.length, 'claim') }]
        : [
            {
              label: `${results.filter((x) => x.outcome === 'holds').length}/${results.length} claims hold`,
              intent: health,
            },
          ]),
  ];

  const flags: { text: string; intent?: Intent; buttons?: readonly Button[] }[] = [];
  if (alignment?.mismatch === 'claims-hold-work-open') {
    const open = alignment.items.filter((i) => i.state !== 'closed');
    flags.push({
      text: `Every claim holds but ${open.map((i) => i.id).join(', ')} ${open.length === 1 ? 'is' : 'are'} still open.`,
      intent: 'primary',
      buttons: open.map((i) => ({
        action: 'decide',
        label: `Close ${i.id}`,
        item: i.id,
        decision: 'close',
        primary: true,
      })),
    });
  }
  if (alignment?.mismatch === 'work-closed-claims-violated') {
    flags.push({
      text: 'The work is closed but a claim is violated: closed too early, or regressed.',
      intent: 'danger',
      buttons: alignment.items.map((i) => ({
        action: 'decide',
        label: `Reopen ${i.id}`,
        item: i.id,
        decision: 'reopen',
      })),
    });
  }
  if (contested) {
    flags.push({
      text: 'Edited on two branches at once. Edit it to settle which text stands.',
      intent: 'warning',
    });
  }

  const quoted = plan.annotations.filter((a) => a.requirement === r.id && marks.has(a.id));
  const evidence: Chip[] = r.claims.map((claim, i) => {
    const result = results[i];
    const expression = `${claim.kind} ${claim.expression}${claim.expect ? '' : ' (expect none)'}`;
    return result === undefined
      ? { label: `${expression} · not checked` }
      : { label: `${expression} · ${result.evidence}`, intent: OUTCOME_INTENT[result.outcome] };
  });

  return {
    id: r.id,
    title: r.title,
    version: r.revision,
    health,
    ...(note === '' ? {} : { note }),
    tags,
    properties,
    body: {
      kind: 'markdown',
      source: r.text,
      ...(quoted.length > 0
        ? { marks: quoted.map((a) => ({ text: a.quote ?? '', id: marks.get(a.id) ?? '' })) }
        : {}),
    },
    ...(delta === undefined
      ? {}
      : {
          proposed: {
            kind: 'diff',
            before: r.text,
            after: delta.op === 'remove' ? '' : delta.requirement.text,
          },
        }),
    evidence,
    ...(flags.length > 0 ? { flags } : {}),
    editable: { title: r.title, text: r.text },
  };
}

/**
 * Threads are one level deep on the page: a reply to a reply joins its thread's replies, in the
 * order they were written. A reply whose parent is gone becomes a thread of its own.
 */
function projectThreads(
  plan: PlanState,
  state: ReturnType<typeof foldLog>,
  marks: ReadonlyMap<string, string>,
  atOf: ReadonlyMap<string, number>,
  isAgent: (actor: string) => boolean,
  when: (at: number | undefined) => string,
): ReviewThread[] {
  const byId = new Map(plan.annotations.map((a) => [a.id, a]));
  const rootOf = (a: Annotation): Annotation => {
    let current = a;
    const seen = new Set<string>();
    while (current.replyTo !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.replyTo);
      if (parent === undefined) break;
      current = parent;
    }
    return current;
  };
  const reply = (a: Annotation): Reply => ({
    author: a.author,
    ...(isAgent(a.author) ? { agent: true } : {}),
    when: when(atOf.get(a.id)),
    body: a.body,
  });
  const roots = plan.annotations.filter((a) => rootOf(a) === a);
  return roots.map((a) => {
    const mark = marks.get(a.id);
    return {
      id: a.id,
      section: a.requirement,
      ...(mark === undefined ? {} : { mark }),
      ...(a.quote === undefined || a.quote === '' ? {} : { quote: a.quote }),
      ...reply(a),
      outdated: isAnnotationOutdated(state, plan.id, a),
      replies: plan.annotations.filter((b) => b !== a && rootOf(b) === a).map(reply),
    };
  });
}

/** What happened, newest first, as sentences a person reads. */
function projectActivity(
  options: ProjectOptions,
  plan: PlanState,
  state: ReturnType<typeof foldLog>,
  isAgent: (actor: string) => boolean,
  when: (at: number | undefined) => string,
): ReviewActivity[] {
  const titleOf = (id: string) => plan.heads.get(id)?.title ?? id;
  const changeTitle = (id: string) => state.changes.get(id)?.change.title ?? id;
  const ofPlan = (changeId: string) => state.changes.get(changeId)?.change.planId === plan.id;
  const sentence = (event: YojanaEvent): string | undefined => {
    switch (event.type) {
      case 'revision-recorded':
        if (event.planId !== plan.id) return undefined;
        return event.base === undefined
          ? `added “${event.requirement.title}”`
          : `revised “${event.requirement.title}”`;
      case 'requirement-removed':
        return event.planId === plan.id ? `removed ${event.id}` : undefined;
      case 'change-opened':
        return event.change.planId === plan.id ? `opened “${event.change.title}”` : undefined;
      case 'change-archived':
        return ofPlan(event.changeId) ? `accepted “${changeTitle(event.changeId)}”` : undefined;
      case 'change-abandoned':
        return ofPlan(event.changeId)
          ? `rejected “${changeTitle(event.changeId)}”: ${event.reason}`
          : undefined;
      case 'status-changed':
        return event.planId === plan.id ? `moved the plan to ${event.to}` : undefined;
      case 'annotation-added':
        if (event.planId !== plan.id) return undefined;
        return event.annotation.replyTo === undefined
          ? `commented on “${titleOf(event.annotation.requirement)}”`
          : `replied on “${titleOf(event.annotation.requirement)}”`;
      case 'work-linked':
        return event.planId === plan.id
          ? `linked ${event.workItems.length === 0 ? 'no work items' : event.workItems.join(', ')}`
          : undefined;
    }
  };
  const out: ReviewActivity[] = [];
  for (let i = options.events.length - 1; i >= 0 && out.length < ACTIVITY_LIMIT; i--) {
    const event = options.events[i];
    if (event === undefined) continue;
    const what = sentence(event);
    if (what === undefined) continue;
    out.push({
      id: event.eventId,
      who: event.actor,
      kind:
        options.you !== undefined && event.actor === options.you
          ? 'you'
          : isAgent(event.actor)
            ? 'agent'
            : 'person',
      what,
      when: when(event.at),
    });
  }
  return out;
}
