import {
  type Annotation,
  type ChangeState,
  type ClaimResult,
  type FoldState,
  foldLog,
  isAnnotationOutdated,
  type PlanState,
  type Requirement,
  type StorePort,
} from '@cntxt-labs/yojana-core';
import { SELECTION_SCRIPT } from './review-live.ts';
import type { PlanReport, StatusReport } from './status.ts';

/**
 * Review: a plan rendered as one self-contained HTML page for reading and discussing. Markdown is
 * where plans are edited; this is where they are reviewed. It shows each requirement with its
 * claim results, linked work items (and close?/reopen? flags), and comment threads. A comment
 * whose requirement has changed since it was written is marked outdated. Its quoted span is
 * highlighted only while the requirement still reads as it did.
 *
 * Everything from the plan is escaped: plan text is data, never markup.
 */

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/**
 * A small, safe Markdown subset: paragraphs, fenced code, `###`+ headings, list items, inline code
 * and bold. Anything else shows as text. Each requirement's text is rendered on its own.
 */
export function renderMarkdown(markdown: string, highlight?: readonly string[]): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let code: string[] | undefined;
  const mark = (html: string) => {
    let result = html;
    for (const quote of highlight ?? []) {
      const escaped = escapeHtml(quote);
      if (escaped !== '' && result.includes(escaped)) {
        result = result.replace(escaped, `<mark>${escaped}</mark>`);
      }
    }
    return result;
  };
  const flush = () => {
    if (paragraph.length > 0) out.push(`<p>${mark(inline(paragraph.join(' ')))}</p>`);
    if (list.length > 0)
      out.push(`<ul>${list.map((i) => `<li>${mark(inline(i))}</li>`).join('')}</ul>`);
    paragraph = [];
    list = [];
  };
  for (const line of markdown.split('\n')) {
    if (code !== undefined) {
      if (/^ {0,3}(`{3,}|~{3,})\s*$/.test(line)) {
        out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        code = undefined;
      } else {
        code.push(line);
      }
      continue;
    }
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
      flush();
      code = [];
      continue;
    }
    const heading = /^#{2,6}\s+(.*)$/.exec(line);
    if (heading !== null) {
      flush();
      out.push(`<h4>${inline(heading[1] ?? '')}</h4>`);
      continue;
    }
    const item = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (item !== null) {
      if (paragraph.length > 0) flush();
      list.push(item[1] ?? '');
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (list.length > 0) flush();
    paragraph.push(line.trim());
  }
  if (code !== undefined) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  flush();
  return out.join('\n');
}

const OUTCOME_LABEL: Readonly<Record<ClaimResult['outcome'], string>> = {
  holds: 'holds',
  violated: 'violated',
  unverifiable: 'not checked',
};

/**
 * Everything one review page is drawn from. Built once per request, so a full page and a single
 * requirement (swapped in by htmx after an edit or a comment) come out of the same code.
 */
export interface ReviewContext {
  readonly state: FoldState;
  readonly plan: PlanState;
  readonly report: PlanReport | undefined;
  readonly checks: readonly ClaimResult[];
  readonly atOf: ReadonlyMap<string, number>;
  /** Present when served: the page can write, through htmx, with this token. */
  readonly live: { readonly token: string; readonly checkedAt?: number | undefined } | undefined;
}

export interface ReviewOptions {
  readonly store: StorePort;
  readonly planId: string;
  readonly status: StatusReport;
  readonly checks?: readonly ClaimResult[] | undefined;
  /** Served by `review --serve`: adds edit, suggest, comment, reply, accept and reject. */
  readonly interactive?:
    | { readonly token: string; readonly checkedAt?: number | undefined }
    | undefined;
}

export async function reviewContext(options: ReviewOptions): Promise<ReviewContext | undefined> {
  const events = await options.store.events();
  const state = foldLog(events);
  const plan = state.plans.get(options.planId);
  if (plan === undefined) return undefined;
  const atOf = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'annotation-added') atOf.set(event.annotation.id, event.at);
  }
  return {
    state,
    plan,
    report: options.status.plans.find((p) => p.planId === plan.id),
    checks: options.checks ?? [],
    atOf,
    live: options.interactive,
  };
}

function day(ms: number | undefined): string {
  return ms === undefined
    ? ''
    : new Date(ms).toISOString().slice(0, 'yyyy-mm-ddThh:mm'.length).replace('T', ' ');
}

/** URL path segment for a plan id (`plan/x` -> `plan%2Fx`). */
function planPath(planId: string): string {
  return `/plan/${encodeURIComponent(planId)}`;
}

/** An element id for a requirement's or comment's form slot. */
function slotId(key: string): string {
  return `slot-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function thread(ctx: ReviewContext, annotations: readonly Annotation[]): string {
  const outdated = (a: Annotation) => isAnnotationOutdated(ctx.state, ctx.plan.id, a);
  const replies = (id: string): Annotation[] => annotations.filter((a) => a.replyTo === id);
  const one = (a: Annotation, depth: number): string => {
    const badge = outdated(a)
      ? '<span class="pill warn" title="The requirement changed after this was written">outdated</span>'
      : '';
    const quote = a.quote === undefined ? '' : `<blockquote>${escapeHtml(a.quote)}</blockquote>`;
    const nested = replies(a.id)
      .map((r) => one(r, depth + 1))
      .join('');
    const reply =
      ctx.live === undefined
        ? ''
        : ` <button type="button" class="link" hx-get="${planPath(ctx.plan.id)}/form/reply/${encodeURIComponent(a.requirement)}?to=${encodeURIComponent(a.id)}" hx-target="#${slotId(a.id)}">Reply</button>`;
    return `<li class="comment${depth > 0 ? ' reply' : ''}"><div class="who"><b>${escapeHtml(a.author)}</b> <span class="muted">${escapeHtml(day(ctx.atOf.get(a.id)))} · ${escapeHtml(a.id)}</span> ${badge}${reply}</div>${quote}<p>${inline(a.body)}</p><div id="${slotId(a.id)}"></div>${nested === '' ? '' : `<ul class="thread">${nested}</ul>`}</li>`;
  };
  const roots = annotations.filter(
    (a) => a.replyTo === undefined || !annotations.some((b) => b.id === a.replyTo),
  );
  return roots.length === 0
    ? ''
    : `<ul class="thread">${roots.map((a) => one(a, 0)).join('')}</ul>`;
}

/** One requirement, as a page section. Undefined when the plan has no such requirement. */
export function renderSection(ctx: ReviewContext, requirementId: string): string | undefined {
  const requirement = ctx.plan.heads.get(requirementId);
  if (requirement === undefined) return undefined;
  const notes = ctx.plan.annotations.filter((a) => a.requirement === requirement.id);
  const current = notes.filter((a) => !isAnnotationOutdated(ctx.state, ctx.plan.id, a));
  const highlights = current.flatMap((a) => (a.quote === undefined ? [] : [a.quote]));
  const claims = ctx.checks.filter((c) => c.requirement === requirement.id);
  const claimList =
    requirement.claims.length === 0
      ? '<p class="muted">No claims yet.</p>'
      : `<ul class="claims">${requirement.claims
          .map((claim, i) => {
            const result = claims[i];
            const pill =
              result === undefined
                ? ''
                : `<span class="pill ${result.outcome}">${OUTCOME_LABEL[result.outcome]}</span>`;
            const evidence =
              result === undefined
                ? ''
                : `<div class="muted small">${escapeHtml(result.evidence)}</div>`;
            const expectNone = claim.expect ? '' : ' <span class="muted">(expect none)</span>';
            return `<li>${pill}<code>${escapeHtml(claim.kind)}</code> <code>${escapeHtml(claim.expression)}</code>${expectNone}${evidence}</li>`;
          })
          .join('')}</ul>`;
  const alignment = ctx.report?.alignment.find((a) => a.requirement === requirement.id);
  const work = (requirement.workItems ?? []).map((id) => {
    const item = alignment?.items.find((i) => i.id === id);
    return `<span class="pill ${item?.state === 'closed' ? 'holds' : 'neutral'}">${escapeHtml(id)}${item === undefined ? '' : ` · ${escapeHtml(item.state)}`}</span>`;
  });
  const flag =
    alignment?.mismatch === 'claims-hold-work-open'
      ? '<p class="flag">Every claim holds but the work item is still open. Close it?</p>'
      : alignment?.mismatch === 'work-closed-claims-violated'
        ? '<p class="flag bad">The work item is closed but a claim is violated. Reopen it?</p>'
        : '';
  const comments = thread(ctx, notes);
  const rid = escapeHtml(requirement.id);
  const base = `${planPath(ctx.plan.id)}/form`;
  const slot = slotId(requirement.id);
  const req = encodeURIComponent(requirement.id);
  const actions =
    ctx.live === undefined
      ? ''
      : `<div class="actions"><button type="button" hx-get="${base}/edit/${req}" hx-target="#${slot}">Edit</button><button type="button" hx-get="${base}/suggest/${req}" hx-target="#${slot}">Suggest edit</button><button type="button" hx-get="${base}/comment/${req}" hx-target="#${slot}">Comment</button></div><div id="${slot}"></div>`;
  return `<section class="req" id="${rid}">
  <header><h2>${inline(requirement.title)}</h2><a class="anchor" href="#${rid}">#${rid}</a></header>
  ${work.length > 0 ? `<div class="work">${work.join(' ')}</div>` : ''}
  ${flag}
  <div class="text" data-req="${rid}">${renderMarkdown(requirement.text, highlights) || '<p class="muted">No text.</p>'}</div>
  ${claimList}
  ${actions}
  ${comments === '' ? '' : `<div class="comments"><h3>Comments</h3>${comments}</div>`}
</section>`;
}

function renderChanges(ctx: ReviewContext, openChanges: readonly ChangeState[]): string {
  if (openChanges.length === 0) return '';
  return `<section class="changes"><h2>Open changes</h2>${openChanges
    .map((c) => {
      const cid = escapeHtml(c.change.id);
      const deltas = c.change.deltas
        .map((d) => {
          const id = d.op === 'remove' ? d.id : d.requirement.id;
          const now = ctx.plan.heads.get(id);
          const before =
            now === undefined ? '<p class="muted">Not in the plan.</p>' : renderMarkdown(now.text);
          const after =
            d.op === 'remove'
              ? '<p class="muted">Removed.</p>'
              : `<p><b>${inline(d.requirement.title)}</b></p>${renderMarkdown(d.requirement.text)}`;
          return `<div class="delta"><div class="muted small">${escapeHtml(d.op)} ${escapeHtml(id)}</div><div class="sides"><div><div class="label">now</div>${before}</div><div><div class="label">proposed</div>${after}</div></div></div>`;
        })
        .join('');
      const slot = slotId(`change-${c.change.id}`);
      const buttons =
        ctx.live === undefined
          ? ''
          : `<div class="actions"><button type="button" class="primary" hx-post="/api/accept" hx-vals='${escapeHtml(JSON.stringify({ changeId: c.change.id }))}' hx-target="#${slot}">Accept</button><button type="button" hx-get="${planPath(ctx.plan.id)}/form/reject/${encodeURIComponent(c.change.id)}" hx-target="#${slot}">Reject</button></div><div id="${slot}"></div>`;
      return `<article class="change"><header><b>${escapeHtml(c.change.title)}</b> <span class="muted small">${cid} · opened ${escapeHtml(day(c.openedAt))}</span></header>${deltas}${buttons}</article>`;
    })
    .join('')}</section>`;
}

// Forms. Each posts with htmx and, on success, the server answers with the updated section (or
// asks for a reload); on failure it answers with the same form, the person's input kept, and why.

function hidden(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
    .join('');
}

function errorLine(error: string | undefined): string {
  return error === undefined ? '' : `<p class="error" role="alert">${escapeHtml(error)}</p>`;
}

const CANCEL = '<button type="button" onclick="this.closest(\'form\').remove()">Cancel</button>';

export function editForm(options: {
  readonly planId: string;
  readonly requirement: Requirement;
  readonly mode: 'edit' | 'suggest';
  readonly values?: {
    readonly title?: string | undefined;
    readonly text?: string | undefined;
    readonly why?: string | undefined;
  };
  readonly error?: string | undefined;
}): string {
  const { requirement, mode } = options;
  const title = options.values?.title ?? requirement.title;
  const text = options.values?.text ?? requirement.text;
  const why =
    mode === 'suggest'
      ? `<label><span class="label">Why (optional)</span><textarea name="why" rows="3">${escapeHtml(options.values?.why ?? '')}</textarea></label>`
      : '';
  return `<form class="inline" hx-post="/api/${mode}" hx-swap="outerHTML">${hidden({ planId: options.planId, requirement: requirement.id, revision: requirement.revision })}<label><span class="label">Title</span><input name="title" value="${escapeHtml(title)}" required></label><label><span class="label">Text (Markdown)</span><textarea name="text">${escapeHtml(text)}</textarea></label>${why}${errorLine(options.error)}<div class="actions"><button class="primary">${mode === 'edit' ? 'Save to the plan' : 'Open as a change'}</button>${CANCEL}</div></form>`;
}

export function commentForm(options: {
  readonly planId: string;
  readonly requirementId: string;
  readonly quote?: string | undefined;
  readonly replyTo?: string | undefined;
  readonly body?: string | undefined;
  readonly error?: string | undefined;
}): string {
  const quote = options.quote ?? '';
  const quoteField =
    options.replyTo !== undefined
      ? hidden({ replyTo: options.replyTo })
      : `<label><span class="label">Quote (optional; selecting text in the requirement fills it)</span><input name="quote" value="${escapeHtml(quote)}"></label>`;
  return `<form class="inline" hx-post="/api/comment" hx-swap="outerHTML">${hidden({ planId: options.planId, requirement: options.requirementId })}${quote !== '' && options.replyTo === undefined ? `<blockquote>${escapeHtml(quote)}</blockquote>` : ''}<label><span class="label">${options.replyTo === undefined ? 'Comment' : 'Reply'}</span><textarea name="body" rows="3" required>${escapeHtml(options.body ?? '')}</textarea></label>${quoteField}${errorLine(options.error)}<div class="actions"><button class="primary">${options.replyTo === undefined ? 'Comment' : 'Reply'}</button>${CANCEL}</div></form>`;
}

export function rejectForm(options: {
  readonly changeId: string;
  readonly error?: string | undefined;
}): string {
  return `<form class="inline" hx-post="/api/reject" hx-swap="outerHTML">${hidden({ changeId: options.changeId })}<label><span class="label">Why reject it?</span><input name="reason" required></label>${errorLine(options.error)}<div class="actions"><button class="primary">Reject</button>${CANCEL}</div></form>`;
}

export function errorFragment(message: string): string {
  return errorLine(message);
}

/** htmx swaps 4xx answers too, so a refused form comes back in place with its reason. */
const HTMX_CONFIG = JSON.stringify({
  responseHandling: [
    { code: '204', swap: false },
    { code: '[23]..', swap: true },
    { code: '4..', swap: true, error: false },
    { code: '...', swap: false, error: true },
  ],
});

export async function review(
  options: ReviewOptions & { readonly generatedAt: number },
): Promise<string | undefined> {
  const ctx = await reviewContext(options);
  if (ctx === undefined) return undefined;
  const { plan, live } = ctx;
  const sections = [...plan.heads.keys()].map((id) => renderSection(ctx, id) ?? '');
  const openChanges = [...ctx.state.changes.values()].filter(
    (c) => c.status === 'open' && c.change.planId === plan.id,
  );

  const progress = ctx.report?.progress;
  const progressText =
    progress === undefined || progress.error !== undefined
      ? ''
      : `<span>${progress.done}/${progress.total} work items done</span>`;
  const tally = (o: ClaimResult['outcome']) => ctx.checks.filter((c) => c.outcome === o).length;
  const claimsText =
    ctx.checks.length === 0
      ? '<span>claims not checked</span>'
      : `<span>${tally('holds')} hold · ${tally('violated')} violated · ${tally('unverifiable')} not checked</span>`;
  const checkedAt = live?.checkedAt;
  const refresh =
    live === undefined
      ? ''
      : `<div class="actions"><span class="muted small">${checkedAt === undefined ? 'beads cached by the server' : `claims checked ${escapeHtml(day(checkedAt))} UTC; beads cached`}</span><button type="button" hx-post="/api/check" hx-vals='${escapeHtml(JSON.stringify({ planId: plan.id }))}' hx-target="#slot-refresh" hx-indicator="#slot-refresh">Refresh checks and beads</button></div><div id="slot-refresh"><span class="htmx-indicator muted small">Refreshing; bd and anvesa can take a little while…</span></div>`;
  const outdatedCount = plan.annotations.filter((a) =>
    isAnnotationOutdated(ctx.state, plan.id, a),
  ).length;
  const headExtras =
    live === undefined
      ? ''
      : `<meta name="htmx-config" content="${escapeHtml(HTMX_CONFIG)}">
<script src="/static/htmx.js"></script>`;
  const bodyAttributes =
    live === undefined
      ? ''
      : ` hx-headers='${escapeHtml(JSON.stringify({ 'x-yojana-token': live.token }))}' data-plan="${escapeHtml(plan.id)}"`;
  const selection =
    live === undefined
      ? ''
      : `<div id="selbar" hidden><button type="button" data-sel="comment">Comment</button><button type="button" data-sel="suggest">Suggest edit</button></div>
<div id="selpop" hidden></div>
<script>${SELECTION_SCRIPT}</script>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(plan.id)} review</title>
${headExtras}
<style>
${STYLES}
</style>
</head>
<body${bodyAttributes}>
<main>
  <div class="top">
    <h1>${escapeHtml(plan.id)}</h1>
    <div class="meta"><span>${escapeHtml(plan.status)}</span><span>${plan.heads.size} requirements</span>${progressText}${claimsText}<span>${plan.annotations.length} ${plan.annotations.length === 1 ? 'comment' : 'comments'}${outdatedCount > 0 ? ` (${outdatedCount} outdated)` : ''}</span>${openChanges.length > 0 ? `<span>${openChanges.length} open ${openChanges.length === 1 ? 'change' : 'changes'}</span>` : ''}<span>generated ${escapeHtml(day(options.generatedAt))} UTC</span>${live === undefined ? '' : '<span>live: edits save to the repository</span>'}</div>
    ${refresh}
  </div>
${renderChanges(ctx, openChanges)}
${sections.join('\n')}
</main>
${selection}
</body>
</html>
`;
}

const STYLES = `:root { --bg:#f6f7f9; --surface:#fff; --ink:#1b2430; --muted:#5d6a78; --rule:#d9dfe6; --accent:#2f4f9e; --soft:#e7edf8; --ok:#2c7a4b; --bad:#b23a3a; --warn:#9a5a10; --mark:#fff1a8; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#12161c; --surface:#1a2029; --ink:#e3e8ee; --muted:#9aa7b4; --rule:#2c3540; --accent:#8fa9ec; --soft:#222c40; --ok:#6cc28f; --bad:#ec8a8a; --warn:#e0a15e; --mark:#5a4a12; color-scheme: dark; } }
:root[data-theme="dark"] { --bg:#12161c; --surface:#1a2029; --ink:#e3e8ee; --muted:#9aa7b4; --rule:#2c3540; --accent:#8fa9ec; --soft:#222c40; --ok:#6cc28f; --bad:#ec8a8a; --warn:#e0a15e; --mark:#5a4a12; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15.5px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; padding:0 16px; }
main { max-width:780px; margin:0 auto; padding-block:40px 72px; display:grid; gap:28px; }
.top { display:grid; gap:8px; border-bottom:1px solid var(--rule); padding-bottom:20px; }
.top h1 { margin:0; font-size:clamp(26px,5vw,36px); line-height:1.15; text-wrap:balance; }
.meta { display:flex; flex-wrap:wrap; gap:6px 16px; color:var(--muted); font:13px/1.4 ui-monospace,Consolas,monospace; }
.req { background:var(--surface); border:1px solid var(--rule); border-radius:8px; padding:18px 20px; display:grid; gap:12px; min-width:0; }
.req header { display:flex; flex-wrap:wrap; align-items:baseline; gap:6px 12px; }
.req h2 { margin:0; font-size:19px; line-height:1.3; }
.anchor { font:12.5px ui-monospace,Consolas,monospace; color:var(--accent); text-decoration:none; }
.text p, .text ul { margin:0 0 8px; max-width:68ch; }
.text h4 { margin:10px 0 4px; font-size:14.5px; }
pre { margin:0; overflow-x:auto; background:var(--bg); border:1px solid var(--rule); border-radius:6px; padding:10px 12px; font:13px/1.5 ui-monospace,Consolas,monospace; }
code { font:0.9em ui-monospace,Consolas,monospace; background:var(--soft); padding:0.1em 0.3em; border-radius:3px; overflow-wrap:anywhere; }
pre code { background:none; padding:0; }
mark { background:var(--mark); color:inherit; padding:0 2px; border-radius:2px; }
.claims { list-style:none; padding:0; margin:0; display:grid; gap:6px; }
.pill { display:inline-block; font:12px/1.6 ui-monospace,Consolas,monospace; padding:0 8px; border-radius:999px; border:1px solid var(--rule); margin-right:6px; }
.pill.holds { color:var(--ok); border-color:var(--ok); }
.pill.violated { color:var(--bad); border-color:var(--bad); }
.pill.unverifiable, .pill.warn { color:var(--warn); border-color:var(--warn); }
.work { display:flex; flex-wrap:wrap; gap:6px; }
.flag { margin:0; padding:8px 12px; border-left:3px solid var(--accent); background:var(--soft); border-radius:0 6px 6px 0; }
.flag.bad { border-color:var(--bad); }
.comments h3 { margin:4px 0 6px; font-size:14px; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; }
.thread { list-style:none; margin:0; padding:0; display:grid; gap:10px; }
.comment { border-left:2px solid var(--rule); padding-left:12px; }
.comment p { margin:4px 0 0; }
.comment .thread { margin-top:8px; }
blockquote { margin:6px 0 0; padding-left:10px; border-left:3px solid var(--mark); color:var(--muted); }
.muted { color:var(--muted); }
.small { font-size:12.5px; overflow-wrap:anywhere; }
.changes { display:grid; gap:12px; }
.changes h2 { margin:0; font-size:19px; }
.change { background:var(--surface); border:1px solid var(--accent); border-radius:8px; padding:14px 18px; display:grid; gap:10px; }
.sides { display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:12px; }
.sides > div { min-width:0; }
.label { font:11.5px ui-monospace,Consolas,monospace; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
.actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
button { font:inherit; font-size:13.5px; padding:5px 12px; border-radius:6px; border:1px solid var(--rule); background:var(--surface); color:var(--ink); cursor:pointer; }
button:hover { border-color:var(--accent); }
button:focus-visible, textarea:focus-visible, input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
button.primary { background:var(--accent); border-color:var(--accent); color:var(--surface); }
button.link { border:0; padding:0 4px; background:none; color:var(--accent); font-size:12.5px; }
form.inline { display:grid; gap:8px; margin-top:8px; }
form.inline label { display:grid; gap:4px; }
form.inline textarea, form.inline input { font:13.5px/1.5 ui-monospace,Consolas,monospace; width:100%; padding:8px 10px; border:1px solid var(--rule); border-radius:6px; background:var(--bg); color:var(--ink); }
form.inline textarea[name="text"] { min-height:160px; resize:vertical; }
.error { margin:0; padding:8px 12px; border-left:3px solid var(--bad); background:var(--soft); border-radius:0 6px 6px 0; white-space:pre-wrap; }
.htmx-indicator { display:none; }
.htmx-request .htmx-indicator, .htmx-request.htmx-indicator { display:inline; }
#selbar { position:absolute; z-index:10; display:flex; gap:4px; padding:4px; background:var(--ink); border-radius:8px; box-shadow:0 4px 14px rgba(0,0,0,.2); }
#selbar[hidden], #selpop[hidden] { display:none; }
#selbar button { background:transparent; border:0; color:var(--bg); padding:4px 10px; }
#selbar button:hover { background:color-mix(in srgb, var(--bg) 18%, transparent); }
#selpop { position:absolute; z-index:10; width:min(420px, calc(100vw - 32px)); background:var(--surface); border:1px solid var(--accent); border-radius:8px; padding:4px 14px 14px; box-shadow:0 8px 24px rgba(0,0,0,.18); }`;
