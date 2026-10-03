import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  abandonChange,
  archiveChange,
  type CheckReport,
  check,
  comment,
  commentForm,
  editForm,
  editRequirement,
  errorFragment,
  escapeHtml,
  loadPlanFiles,
  openWorkspace,
  type ReviewContext,
  rejectForm,
  renderSection,
  review,
  reviewContext,
  settleChangeFile,
  status,
  suggestEdit,
  type Workspace,
} from '@cntxt-labs/yojana';
import {
  foldLog,
  type VerifierPort,
  type WorkLinkPort,
  type WorkLookup,
  YojanaError,
} from '@cntxt-labs/yojana-core';
import htmxSource from 'htmx.org/dist/htmx.min.js' with { type: 'text' };

/**
 * `yojana review --serve`: the review page, live, on this machine only, driven by htmx.
 *
 *   GET  /                                   plans in the log
 *   GET  /plan/<id>                          the review page
 *   GET  /plan/<id>/form/<kind>/<target>     a form: edit, suggest, comment, reply, reject
 *   POST /api/edit|suggest|comment|accept|reject|check   (form-encoded, as htmx sends)
 *   GET  /static/htmx.js                     htmx, served from the installed package (0BSD)
 *
 * Answers are HTML. A write that succeeds answers with the updated requirement (htmx swaps it in
 * place) or asks for a reload; one that is refused answers with the same form, input kept, and
 * why. Every write goes through the engine with the same checks as the CLI, one at a time, on a
 * log reopened for the request, so the CLI can be used alongside. Writes need the token the page
 * carries (htmx sends it as a header) and a Host of this server: another website cannot post here.
 */

export interface ServeOptions {
  readonly root: string;
  readonly plansDir: string | undefined;
  readonly changesDir: string | undefined;
  /** 0 picks a free port. */
  readonly port: number;
  readonly actor: string;
  readonly runCheck: boolean;
  readonly verifiers: () => VerifierPort[];
  readonly worklink: () => WorkLinkPort;
}

export interface ReviewServer {
  readonly url: string;
  readonly token: string;
  stop(): void;
}

type Fields = Record<string, string>;

/** Seconds a request may run before Bun drops the connection (its default is 10). */
const IDLE_SECONDS = 120;

function html(body: string, statusCode = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: statusCode,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

/** Ask htmx to reload the page: for changes that touch more than one part of it. */
function reload(): Response {
  return html('', 200, { 'HX-Refresh': 'true' });
}

/** Put this requirement's fresh section where it was, replacing the form that asked. */
function swapSection(requirementId: string, body: string): Response {
  return html(body, 200, {
    'HX-Retarget': `[id="${requirementId}"]`,
    'HX-Reswap': 'outerHTML',
  });
}

export function startReviewServer(options: ServeOptions): ReviewServer {
  const token = randomUUID();
  const toSource = (path: string) => relative(options.root, path).split(sep).join('/');
  /** The previous write's completion; a write waits for it, so writes never interleave. */
  let lastWrite: Promise<void> = Promise.resolve();

  /** Run with the workspace's log open; writes wait their turn. */
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

  // bd takes seconds per call to start, so its answers are cached, until the page asks for a
  // refresh. A failed lookup is not cached: the next page load asks again.
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

  // Claim checks run anvesa once per claim, which takes seconds; they are cached per plan and
  // re-run on request, not on every page load.
  const checked = new Map<string, { readonly report: CheckReport; readonly at: number }>();
  const runChecks = async (ws: Workspace, planId: string) => {
    const report = await check({ store: ws.store, verifiers: options.verifiers(), planId });
    const entry = { report, at: Date.now() };
    checked.set(planId, entry);
    return entry;
  };

  const context = async (ws: Workspace, planId: string): Promise<ReviewContext | undefined> => {
    const cached = options.runCheck
      ? (checked.get(planId) ?? (await runChecks(ws, planId)))
      : undefined;
    const report = await status({
      store: ws.store,
      parser: ws.parser,
      bases: ws.bases,
      files: loadPlanFiles(options.root, ws.plansDir),
      worklink,
      checks: cached?.report,
      now: Date.now(),
      staleDays: 14,
      planId,
    });
    return reviewContext({
      store: ws.store,
      planId,
      status: report,
      checks: cached?.report.plans.find((p) => p.planId === planId)?.results,
      interactive: { token, checkedAt: cached?.at },
    });
  };

  const section = async (ws: Workspace, planId: string, requirementId: string) => {
    const ctx = await context(ws, planId);
    return (ctx === undefined ? undefined : renderSection(ctx, requirementId)) ?? '';
  };

  const page = (planId: string) =>
    withLog(async (ws) => {
      const cached = options.runCheck
        ? (checked.get(planId) ?? (await runChecks(ws, planId)))
        : undefined;
      const report = await status({
        store: ws.store,
        parser: ws.parser,
        bases: ws.bases,
        files: loadPlanFiles(options.root, ws.plansDir),
        worklink,
        checks: cached?.report,
        now: Date.now(),
        staleDays: 14,
        planId,
      });
      return review({
        store: ws.store,
        planId,
        status: report,
        checks: cached?.report.plans.find((p) => p.planId === planId)?.results,
        generatedAt: Date.now(),
        interactive: { token, checkedAt: cached?.at },
      });
    }, false);

  const index = () =>
    withLog(async (ws) => {
      const plans = [...foldLog(await ws.store.events()).plans.values()];
      const items = plans
        .map(
          (p) =>
            `<li><a href="/plan/${encodeURIComponent(p.id)}">${escapeHtml(p.id)}</a> <span>${escapeHtml(p.status)} · ${p.heads.size} requirements</span></li>`,
        )
        .join('');
      return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>yojana review</title><style>body{font:16px/1.6 system-ui,sans-serif;margin:0;padding:40px 16px;background:#f6f7f9;color:#1b2430}main{max-width:720px;margin:0 auto}li{margin:6px 0}span{color:#5d6a78;font-size:14px}@media (prefers-color-scheme:dark){body{background:#12161c;color:#e3e8ee}a{color:#8fa9ec}span{color:#9aa7b4}}</style></head><body><main><h1>Plans</h1>${items === '' ? '<p>No plans in the log yet; run yojana ingest.</p>' : `<ul>${items}</ul>`}</main></body></html>`;
    }, false);

  /** GET /plan/<id>/form/<kind>/<target>: a form, drawn from the log as it is now. */
  const form = (planId: string, kind: string, target: string, query: URLSearchParams) =>
    withLog(async (ws) => {
      const plan = foldLog(await ws.store.events()).plans.get(planId);
      if (kind === 'reject') return html(rejectForm({ changeId: target }));
      const requirement = plan?.heads.get(target);
      if (requirement === undefined) {
        return html(errorFragment(`${target} is not a requirement of ${planId}`), 404);
      }
      if (kind === 'edit' || kind === 'suggest') {
        return html(editForm({ planId, requirement, mode: kind }));
      }
      if (kind === 'comment') {
        return html(
          commentForm({ planId, requirementId: target, quote: query.get('quote') ?? undefined }),
        );
      }
      if (kind === 'reply') {
        return html(
          commentForm({ planId, requirementId: target, replyTo: query.get('to') ?? undefined }),
        );
      }
      return html(errorFragment(`no form ${kind}`), 404);
    }, false);

  const api = (action: string, fields: Fields): Promise<Response> =>
    withLog(async (ws) => {
      const planId = fields.planId ?? '';
      const requirementId = fields.requirement ?? '';
      const files = () => loadPlanFiles(options.root, ws.plansDir);
      const writePlan = (source: string, content: string) =>
        writeFileSync(join(options.root, source), content);

      if (action === 'check') {
        workCache.clear();
        if (options.runCheck) await runChecks(ws, planId);
        return reload();
      }

      if (action === 'comment') {
        const result = await comment({
          store: ws.store,
          planId,
          requirement: requirementId,
          body: fields.body ?? '',
          author: options.actor,
          quote: fields.quote || undefined,
          replyTo: fields.replyTo || undefined,
        });
        if (!result.ok) {
          return html(
            commentForm({
              planId,
              requirementId,
              quote: fields.quote,
              replyTo: fields.replyTo || undefined,
              body: fields.body,
              error: result.message,
            }),
            400,
          );
        }
        return swapSection(requirementId, await section(ws, planId, requirementId));
      }

      if (action === 'edit' || action === 'suggest') {
        const request = {
          store: ws.store,
          parser: ws.parser,
          planId,
          requirementId,
          expectedRevision: fields.revision ?? '',
          title: fields.title ?? '',
          text: fields.text ?? '',
          actor: options.actor,
        };
        const result =
          action === 'edit'
            ? await editRequirement({ ...request, bases: ws.bases, files: files(), writePlan })
            : await suggestEdit({
                ...request,
                why: fields.why ?? '',
                changesDir: toSource(ws.changesDir),
                writeChange: (source, content) => {
                  mkdirSync(join(options.root, source, '..'), { recursive: true });
                  writeFileSync(join(options.root, source), content);
                },
              });
        if (result.ok) {
          // A suggestion adds an open change at the top of the page; an edit only this section.
          return action === 'suggest'
            ? reload()
            : swapSection(requirementId, await section(ws, planId, requirementId));
        }
        const head = foldLog(await ws.store.events())
          .plans.get(planId)
          ?.heads.get(requirementId);
        if (head === undefined) return html(errorFragment(result.message), 404);
        const message =
          result.code === 'STALE'
            ? `${result.message}. It now reads:\n\n${result.current.text}\n\nReload the page to work on the current text; your text is kept below.`
            : result.message;
        // The form keeps the revision it was opened on, so a stale edit stays refused until the
        // person reloads and sees what changed.
        const shown = { ...head, revision: fields.revision ?? head.revision };
        return html(
          editForm({
            planId,
            requirement: shown,
            mode: action,
            values: { title: fields.title, text: fields.text, why: fields.why },
            error: message,
          }),
          result.code === 'STALE' ? 409 : 400,
        );
      }

      const changeId = fields.changeId ?? '';
      if (action === 'accept') {
        const result = await archiveChange({
          store: ws.store,
          bases: ws.bases,
          parser: ws.parser,
          changeId,
          actor: options.actor,
          planFiles: files(),
          writePlan,
        });
        if (result.outcome !== 'archived') {
          const why = [
            ...result.problems.map((p) => p.message),
            ...result.conflicts.map(
              (c) =>
                `${c.requirement} changed since this change was opened; reject it, or open it again against the current text`,
            ),
          ].join('; ');
          return html(errorFragment(why), 409);
        }
        if (result.change?.source !== undefined) {
          settleChangeFile(options.root, result.change.source, 'archive', new Date());
        }
        return reload();
      }

      if (action === 'reject') {
        const result = await abandonChange({
          store: ws.store,
          changeId,
          reason: fields.reason ?? '',
          actor: options.actor,
        });
        if (result.outcome !== 'abandoned') {
          return html(
            rejectForm({ changeId, error: result.problems.map((p) => p.message).join('; ') }),
            400,
          );
        }
        if (result.change?.source !== undefined) {
          settleChangeFile(options.root, result.change.source, 'abandoned', new Date());
        }
        return reload();
      }

      return html(errorFragment(`no action ${action}`), 404);
    }, true);

  const readFields = async (request: Request): Promise<Fields> => {
    const type = request.headers.get('content-type') ?? '';
    if (type.includes('application/json')) {
      const body = (await request.json()) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(body).map(([k, v]) => [k, typeof v === 'string' ? v : '']),
      );
    }
    const form = await request.formData();
    const fields: Fields = {};
    form.forEach((value, key) => {
      if (typeof value === 'string') fields[key] = value;
    });
    return fields;
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port,
    // Refreshing claim checks can take a while; do not drop the connection meanwhile.
    idleTimeout: IDLE_SECONDS,
    async fetch(request) {
      const url = new URL(request.url);
      const host = request.headers.get('host') ?? '';
      if (host !== `127.0.0.1:${url.port}` && host !== `localhost:${url.port}`) {
        return html(errorFragment('unexpected host'), 403);
      }
      const parts = url.pathname.split('/').map((p) => decodeURIComponent(p));
      try {
        if (request.method === 'GET') {
          if (url.pathname === '/') return html(await index());
          if (url.pathname === '/static/htmx.js') {
            return new Response(htmxSource, {
              headers: { 'content-type': 'text/javascript; charset=utf-8' },
            });
          }
          // ['', 'plan', <id>] or ['', 'plan', <id>, 'form', <kind>, <target>]
          if (parts[1] === 'plan' && parts[2] !== undefined) {
            if (parts.length === 3) {
              const body = await page(parts[2]);
              return body === undefined
                ? html(`<p>No plan ${escapeHtml(parts[2])} in the log.</p>`, 404)
                : html(body);
            }
            if (parts[3] === 'form' && parts[4] !== undefined && parts[5] !== undefined) {
              return await form(parts[2], parts[4], parts[5], url.searchParams);
            }
          }
        }
        if (request.method === 'POST' && parts[1] === 'api' && parts[2] !== undefined) {
          if (request.headers.get('x-yojana-token') !== token) {
            return html(errorFragment('This page is out of date; reload it.'), 403);
          }
          return await api(parts[2], await readFields(request));
        }
        return html(errorFragment('not found'), 404);
      } catch (error) {
        return html(errorFragment(String(error)), 500);
      }
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    token,
    stop: () => server.stop(true),
  };
}
