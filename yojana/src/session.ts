import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import {
  foldLog,
  type VerifierPort,
  type WorkLinkPort,
  type WorkLookup,
  YojanaError,
} from '@cntxt-labs/yojana-core';
import { abandonChange, archiveChange } from './changes.ts';
import { type CheckReport, check } from './check.ts';
import { comment, removeComment } from './comment.ts';
import { applyDecisions, recordDecision } from './decisions.ts';
import { editRequirement, suggestEdit } from './edit.ts';
import {
  approveRequirement,
  declineRequirement,
  declineStatus,
  finalizeStatus,
  proposeStatus,
  settleStatusLine,
} from './plan-status.ts';
import {
  DECLINE_ACTION,
  NEXT_CALLOUT,
  PROPOSAL_CALLOUT,
  projectReview,
  type ReviewDocument,
  type ReviewSection,
} from './project.ts';
import { status } from './status.ts';
import { loadPlanFiles, openWorkspace, settleChangeFile, type Workspace } from './workspace.ts';

/**
 * A review session: one repository's plans, served for review. It is the app side of patra's
 * contract (ADR-001): `load` is the content source (a plan, projected), and `handle` turns a
 * person's intent into the engine command the CLI would run, with the same checks.
 *
 * The intent and answer types here match patra's `Intent` and `IntentAnswer` by shape, so the
 * engine has no dependency on patra; the CLI hands these two functions to patra's server.
 *
 * Every call reopens the log, so the CLI can be used alongside, and writes run one at a time.
 * bd and claim checks take seconds, so their answers are cached until a `refresh`.
 */

/** The template a session's documents are for. */
export const REVIEW_TEMPLATE = 'review-document';
/** Days an open change may sit before status calls it stale. */
const STALE_DAYS = 14;

export interface ReviewIntent {
  readonly template: string;
  readonly document: string;
  readonly action: string;
  readonly target: { readonly part: string; readonly key: string };
  readonly version?: string | undefined;
  readonly payload: Readonly<Record<string, string>>;
  readonly actor: string;
}

export type ReviewAnswer =
  | {
      readonly ok: true;
      readonly update:
        | {
            readonly kind: 'part';
            readonly part: string;
            readonly key: string;
            readonly content: unknown;
          }
        | { readonly kind: 'page' };
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly current?: unknown;
    };

export interface ReviewSessionOptions {
  readonly root: string;
  readonly plansDir?: string | undefined;
  readonly changesDir?: string | undefined;
  /** Check claims when a plan is first shown and on refresh. */
  readonly runCheck: boolean;
  readonly verifiers: () => VerifierPort[];
  readonly worklink: () => WorkLinkPort;
  /** The person at the page: their own activity reads as "you". */
  readonly you?: string | undefined;
  /** How the page opens; the person can switch. */
  readonly mode?: 'read' | 'suggest' | 'edit' | undefined;
  readonly now?: (() => number) | undefined;
}

export interface ReviewSession {
  load(template: string, document: string): Promise<ReviewDocument | undefined>;
  handle(intent: ReviewIntent): Promise<ReviewAnswer>;
  /** The plans in the log, for an index page. */
  plans(): Promise<readonly { id: string; status: string; requirements: number }[]>;
}

const refuse = (code: string, message: string, current?: unknown): ReviewAnswer =>
  current === undefined ? { ok: false, code, message } : { ok: false, code, message, current };
const PAGE: ReviewAnswer = { ok: true, update: { kind: 'page' } };

export function reviewSession(options: ReviewSessionOptions): ReviewSession {
  const now = options.now ?? Date.now;
  const toSource = (path: string) => relative(options.root, path).split(sep).join('/');
  let lastWrite: Promise<void> = Promise.resolve();

  const withLog = <T>(work: (ws: Workspace) => Promise<T>, write: boolean): Promise<T> => {
    const run = async () => {
      const ws = openWorkspace(options.root, {
        plansDir: options.plansDir,
        changesDir: options.changesDir,
      });
      const opened = await ws.store.open();
      if (opened.status === 'corrupt') {
        await ws.store.close();
        throw new YojanaError('STORE_CORRUPT', `the log is unreadable from event ${opened.atSeq}`, {
          hint: 'run yojana repair',
        });
      }
      try {
        return await work(ws);
      } finally {
        await ws.store.close();
      }
    };
    if (!write) return run();
    return (async () => {
      const previous = lastWrite;
      let release = (): void => undefined;
      lastWrite = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await run();
      } finally {
        release();
      }
    })();
  };

  // A failed lookup is not cached: the next load asks again.
  const workCache = new Map<string, Promise<WorkLookup>>();
  const tracker = options.worklink();
  const remember = (key: string, ask: () => Promise<WorkLookup>): Promise<WorkLookup> => {
    const known = workCache.get(key);
    if (known !== undefined) return known;
    const answer = ask().then((lookup) => {
      if (!lookup.ok) workCache.delete(key);
      return lookup;
    });
    workCache.set(key, answer);
    return answer;
  };
  const worklink: WorkLinkPort = {
    name: tracker.name,
    get: (ids) => remember(`get ${ids.join(' ')}`, () => tracker.get(ids)),
    children: (id) => remember(`children ${id}`, () => tracker.children(id)),
  };

  const checked = new Map<string, { readonly report: CheckReport; readonly at: number }>();
  const runChecks = async (ws: Workspace, planId: string) => {
    const report = await check({ store: ws.store, verifiers: options.verifiers(), planId });
    const entry = { report, at: now() };
    checked.set(planId, entry);
    return entry;
  };

  const project = async (ws: Workspace, planId: string): Promise<ReviewDocument | undefined> => {
    const cached = options.runCheck
      ? (checked.get(planId) ?? (await runChecks(ws, planId)))
      : undefined;
    const files = loadPlanFiles(options.root, ws.plansDir);
    const at = now();
    const report = await status({
      store: ws.store,
      parser: ws.parser,
      bases: ws.bases,
      files,
      worklink,
      checks: cached?.report,
      now: at,
      staleDays: STALE_DAYS,
      planId,
    });
    const plan = files
      .map((f) => ws.parser.parse(f.source, f.text))
      .find((p) => p.ok && p.plan.id === planId);
    return projectReview({
      events: await ws.store.events(),
      planId,
      plan: plan?.ok ? plan.plan : undefined,
      report: report.plans.find((p) => p.planId === planId),
      checks: cached?.report.plans.find((p) => p.planId === planId)?.results ?? [],
      checkedAt: cached?.at,
      now: at,
      mode: options.mode ?? 'suggest',
      repository: basename(options.root),
      you: options.you,
    });
  };

  const sectionOf = async (
    ws: Workspace,
    planId: string,
    id: string,
  ): Promise<ReviewSection | undefined> =>
    (await project(ws, planId))?.sections.find((s) => s.id === id);

  const handleIn = async (ws: Workspace, intent: ReviewIntent): Promise<ReviewAnswer> => {
    const planId = intent.document;
    const key = intent.target.key;
    const field = (name: string) => intent.payload[name] ?? '';
    const files = () => loadPlanFiles(options.root, ws.plansDir);
    const writePlan = (source: string, text: string) =>
      writeFileSync(join(options.root, source), text);

    switch (intent.action) {
      case 'refresh': {
        workCache.clear();
        if (options.runCheck) await runChecks(ws, planId);
        return PAGE;
      }

      case 'comment':
      case 'reply': {
        let requirement = key;
        let replyTo: string | undefined;
        if (intent.action === 'reply') {
          const plan = foldLog(await ws.store.events()).plans.get(planId);
          const thread = plan?.annotations.find((a) => a.id === key);
          if (thread === undefined) {
            return refuse('NOT_FOUND', 'That comment is gone; reload the page.');
          }
          requirement = thread.requirement;
          replyTo = thread.id;
        }
        const result = await comment({
          store: ws.store,
          planId,
          requirement,
          body: field('body'),
          author: intent.actor,
          quote: field('quote') || undefined,
          replyTo,
        });
        return result.ok ? PAGE : refuse(result.code, result.message);
      }

      case 'remove': {
        // The thread's own comment, or one of its replies (the form sends the reply's id).
        const result = await removeComment({
          store: ws.store,
          planId,
          id: field('item') || key,
          actor: intent.actor,
        });
        return result.ok ? PAGE : refuse(result.code, result.message);
      }

      case 'edit':
      case 'suggest': {
        const request = {
          store: ws.store,
          parser: ws.parser,
          planId,
          requirementId: key,
          expectedRevision: intent.version ?? '',
          title: field('title'),
          text: field('text'),
          actor: intent.actor,
        };
        const result =
          intent.action === 'edit'
            ? await editRequirement({ ...request, bases: ws.bases, files: files(), writePlan })
            : await suggestEdit({
                ...request,
                why: field('why'),
                changesDir: toSource(ws.changesDir),
                writeChange: (source, text) => {
                  mkdirSync(join(options.root, source, '..'), { recursive: true });
                  writeFileSync(join(options.root, source), text);
                },
              });
        if (result.ok) {
          if (intent.action === 'suggest') return PAGE;
          const section = await sectionOf(ws, planId, key);
          return section === undefined
            ? PAGE
            : { ok: true, update: { kind: 'part', part: 'section', key, content: section } };
        }
        if (result.code === 'STALE') {
          return refuse(
            'STALE',
            `This requirement changed since the page was loaded. It now reads: “${result.current.text}”. Your text is kept below; reload to work on the current version.`,
            await sectionOf(ws, planId, key),
          );
        }
        return refuse(result.code, result.message);
      }

      case 'accept': {
        const result = await archiveChange({
          store: ws.store,
          bases: ws.bases,
          parser: ws.parser,
          changeId: key,
          actor: intent.actor,
          planFiles: files(),
          writePlan,
        });
        if (result.outcome !== 'archived') {
          const why = [
            ...result.problems.map((p) => p.message),
            ...result.conflicts.map(
              (c) =>
                `${c.requirement} changed since this change was opened; reject it, or suggest it again on the current text`,
            ),
          ].join('; ');
          return refuse(result.conflicts.length > 0 ? 'CONFLICT' : 'REFUSED', why);
        }
        if (result.change?.source !== undefined) {
          settleChangeFile(options.root, result.change.source, 'archive', new Date(now()));
        }
        return PAGE;
      }

      case 'reject': {
        const result = await abandonChange({
          store: ws.store,
          changeId: key,
          reason: field('reason'),
          actor: intent.actor,
        });
        if (result.outcome !== 'abandoned') {
          const problem = result.problems[0];
          return refuse(
            problem?.code ?? 'REFUSED',
            result.problems.map((p) => p.message).join('; '),
          );
        }
        if (result.change?.source !== undefined) {
          settleChangeFile(options.root, result.change.source, 'abandoned', new Date(now()));
        }
        return PAGE;
      }

      case 'decide': {
        // A person deciding on the page finalizes at once; it is applied to the tracker now, and
        // a failure is recorded and shown on the page, to be retried.
        const recorded = await recordDecision({
          store: ws.store,
          planId,
          requirement: key,
          item: field('item'),
          decision: field('decision'),
          reason: field('reason'),
          actor: intent.actor,
          finalize: true,
        });
        if (!recorded.ok) return refuse(recorded.code, recorded.message);
        await applyDecisions({
          store: ws.store,
          worklink: tracker,
          actor: intent.actor,
          ids: [recorded.decision.id],
        });
        workCache.clear();
        return PAGE;
      }

      case 'approve': {
        const result = await approveRequirement({
          store: ws.store,
          planId,
          requirement: key,
          revision: intent.version,
          actor: intent.actor,
          agent: false,
        });
        if (!result.ok) {
          return refuse(
            result.code,
            result.code === 'STALE'
              ? 'This requirement changed since the page was loaded; reload and read it again before approving.'
              : result.message,
          );
        }
        // The approval count and the status callout's warnings change with it.
        return PAGE;
      }

      case DECLINE_ACTION: {
        const result = await declineRequirement({
          store: ws.store,
          planId,
          requirement: key,
          reason: field('reason'),
          revision: intent.version,
          actor: intent.actor,
          agent: false,
        });
        if (!result.ok) {
          return refuse(
            result.code,
            result.code === 'STALE'
              ? 'This requirement changed since the page was loaded; reload and read it again before declining.'
              : result.message,
          );
        }
        return PAGE;
      }

      case 'confirm':
      case 'decline': {
        // A person at the page decides: finalize or decline a waiting proposal, or move the plan
        // to the status the page offers. The plan file's status line follows.
        const proposalId = key.startsWith(PROPOSAL_CALLOUT)
          ? key.slice(PROPOSAL_CALLOUT.length)
          : undefined;
        const decided =
          proposalId === undefined
            ? intent.action === 'confirm' && key === NEXT_CALLOUT
              ? await proposeStatus({
                  store: ws.store,
                  planId,
                  to: field('decision'),
                  reason: field('reason') || 'on the review page',
                  actor: intent.actor,
                  agent: false,
                  finalize: true,
                })
              : ({
                  ok: false,
                  code: 'NOT_FOUND',
                  message: 'Nothing is proposed here; reload the page.',
                } as const)
            : intent.action === 'confirm'
              ? await finalizeStatus({
                  store: ws.store,
                  proposalId,
                  reason: field('reason'),
                  actor: intent.actor,
                  agent: false,
                })
              : await declineStatus({
                  store: ws.store,
                  proposalId,
                  reason: field('reason'),
                  actor: intent.actor,
                  agent: false,
                });
        if (!decided.ok) return refuse(decided.code, decided.message);
        await settleStatusLine({
          store: ws.store,
          parser: ws.parser,
          bases: ws.bases,
          files: files(),
          writePlan,
          proposal: decided.proposal,
        });
        return PAGE;
      }

      default:
        return refuse('UNSUPPORTED', `There is no action ${intent.action} on a plan.`);
    }
  };

  return {
    load: (template, document) =>
      template === REVIEW_TEMPLATE
        ? withLog((ws) => project(ws, document), false)
        : Promise.resolve(undefined),
    handle: (intent) =>
      intent.template === REVIEW_TEMPLATE
        ? // Every intent queues as a write, refresh too: it replaces the caches the others read.
          withLog((ws) => handleIn(ws, intent), true)
        : Promise.resolve(refuse('NOT_FOUND', `No template ${intent.template} here.`)),
    plans: () =>
      withLog(async (ws) => {
        const state = foldLog(await ws.store.events());
        return [...state.plans.values()].map((p) => ({
          id: p.id,
          status: p.status,
          requirements: p.heads.size,
        }));
      }, false),
  };
}
