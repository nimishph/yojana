import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  abandonChange,
  archiveChange,
  type CheckReport,
  check,
  comment,
  editRequirement,
  escapeHtml,
  loadPlanFiles,
  openWorkspace,
  review,
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

/**
 * `yojana review --serve`: the review page, live, on this machine only.
 *
 *   GET  /                      plans in the log
 *   GET  /plan/<id>             the review page, with edit, suggest, comment, accept and reject
 *   POST /api/edit|suggest|comment|accept|reject
 *
 * Every write goes through the engine with the same checks as the CLI, one at a time, on a log
 * reopened for the request, so the CLI can be used alongside. Writes need the token embedded in
 * the page and a Host of this server: another website the person has open cannot post here.
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

type Json = Record<string, unknown>;

/** Seconds a request may run before Bun drops the connection (its default is 10). */
const IDLE_SECONDS = 120;

function json(body: Json, statusCode = 200): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function html(body: string, statusCode = 200): Response {
  return new Response(body, {
    status: statusCode,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function startReviewServer(options: ServeOptions): ReviewServer {
  const token = randomUUID();
  const toSource = (path: string) => relative(options.root, path).split(sep).join('/');
  /** The previous write's completion; a write waits for it, so writes never interleave. */
  let lastWrite: Promise<void> = Promise.resolve();

  /** Run with the workspace's log open; writes are queued so they never interleave. */
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

  const writePlan = (source: string, content: string) =>
    writeFileSync(join(options.root, source), content);

  // Claim checks run anvesa once per claim, which takes seconds; they are cached per plan and
  // re-run on request, not on every page load.
  const checked = new Map<string, { readonly report: CheckReport; readonly at: number }>();
  // bd takes seconds per call to start, so its answers are cached too, until the page asks for a
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

  const runChecks = async (ws: Workspace, planId: string) => {
    const report = await check({ store: ws.store, verifiers: options.verifiers(), planId });
    const entry = { report, at: Date.now() };
    checked.set(planId, entry);
    return entry;
  };

  const page = (planId: string) =>
    withLog(async (ws) => {
      const cached = options.runCheck
        ? (checked.get(planId) ?? (await runChecks(ws, planId)))
        : undefined;
      const checks = cached?.report;
      const report = await status({
        store: ws.store,
        parser: ws.parser,
        bases: ws.bases,
        files: loadPlanFiles(options.root, ws.plansDir),
        worklink,
        checks,
        now: Date.now(),
        staleDays: 14,
        planId,
      });
      return review({
        store: ws.store,
        planId,
        status: report,
        checks: checks?.plans.find((p) => p.planId === planId)?.results,
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

  const api = async (action: string, body: Json): Promise<Response> => {
    const planId = text(body.planId);
    const requirement = text(body.requirement);
    return withLog(async (ws) => {
      const files = () => loadPlanFiles(options.root, ws.plansDir);
      if (action === 'check') {
        workCache.clear();
        if (!options.runCheck) return json({ ok: true, message: 'Refreshed the beads.' });
        const { report } = await runChecks(ws, planId);
        return json({
          ok: true,
          message: `Refreshed the beads and checked claims: ${report.holds} hold, ${report.violated} violated, ${report.unverifiable} could not be checked.`,
        });
      }
      if (action === 'comment') {
        const result = await comment({
          store: ws.store,
          planId,
          requirement,
          body: text(body.body),
          author: options.actor,
          quote: text(body.quote) || undefined,
          replyTo: text(body.replyTo) || undefined,
        });
        return result.ok
          ? json({ ok: true, message: `Comment ${result.annotation.id} added.` })
          : json({ ok: false, code: result.code, message: result.message }, 400);
      }
      if (action === 'edit' || action === 'suggest') {
        const request = {
          store: ws.store,
          parser: ws.parser,
          planId,
          requirementId: requirement,
          expectedRevision: text(body.revision),
          title: text(body.title),
          text: text(body.text),
          actor: options.actor,
        };
        const result =
          action === 'edit'
            ? await editRequirement({ ...request, bases: ws.bases, files: files(), writePlan })
            : await suggestEdit({
                ...request,
                why: text(body.why),
                changesDir: toSource(ws.changesDir),
                writeChange: (source, content) => {
                  mkdirSync(join(options.root, source, '..'), { recursive: true });
                  writeFileSync(join(options.root, source), content);
                },
              });
        if (result.ok) {
          return json({
            ok: true,
            message:
              'changeId' in result
                ? `Opened ${result.changeId} (${result.source}).`
                : `Saved ${requirement} to the plan and recorded it.`,
          });
        }
        return json(result, result.code === 'STALE' ? 409 : 400);
      }
      const changeId = text(body.changeId);
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
            ...result.conflicts.map((c) => `${c.requirement} changed since the change was opened`),
          ].join('; ');
          return json({ ok: false, code: 'REFUSED', message: why }, 409);
        }
        if (result.change?.source !== undefined) {
          settleChangeFile(options.root, result.change.source, 'archive', new Date());
        }
        const note =
          result.planFile?.updated === true
            ? 'the plan file is updated'
            : 'the plan file has other edits, so run yojana refresh after ingesting them';
        return json({ ok: true, message: `Accepted ${changeId}; ${note}.` });
      }
      if (action === 'reject') {
        const result = await abandonChange({
          store: ws.store,
          changeId,
          reason: text(body.reason),
          actor: options.actor,
        });
        if (result.outcome !== 'abandoned') {
          return json(
            {
              ok: false,
              code: 'REFUSED',
              message: result.problems.map((p) => p.message).join('; '),
            },
            400,
          );
        }
        if (result.change?.source !== undefined) {
          settleChangeFile(options.root, result.change.source, 'abandoned', new Date());
        }
        return json({ ok: true, message: `Rejected ${changeId}.` });
      }
      return json({ ok: false, code: 'NOT_FOUND', message: `no action ${action}` }, 404);
    }, true);
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    // Re-running claim checks can take a while; do not drop the connection meanwhile.
    idleTimeout: IDLE_SECONDS,
    port: options.port,
    async fetch(request) {
      const url = new URL(request.url);
      const host = request.headers.get('host') ?? '';
      if (host !== `127.0.0.1:${url.port}` && host !== `localhost:${url.port}`) {
        return json({ ok: false, code: 'FORBIDDEN', message: 'unexpected host' }, 403);
      }
      try {
        if (request.method === 'GET' && url.pathname === '/') return html(await index());
        if (request.method === 'GET' && url.pathname.startsWith('/plan/')) {
          const planId = decodeURIComponent(url.pathname.slice('/plan/'.length));
          const body = await page(planId);
          return body === undefined
            ? html(`<p>No plan ${escapeHtml(planId)} in the log.</p>`, 404)
            : html(body);
        }
        if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
          if (request.headers.get('x-yojana-token') !== token) {
            return json(
              { ok: false, code: 'FORBIDDEN', message: 'missing or wrong token; reload the page' },
              403,
            );
          }
          let body: Json;
          try {
            body = (await request.json()) as Json;
          } catch {
            return json({ ok: false, code: 'BAD_REQUEST', message: 'expected a JSON body' }, 400);
          }
          return await api(url.pathname.slice('/api/'.length), body);
        }
        return json({ ok: false, code: 'NOT_FOUND', message: 'not found' }, 404);
      } catch (error) {
        return json({ ok: false, code: 'FAILED', message: String(error) }, 500);
      }
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    token,
    stop: () => server.stop(true),
  };
}
