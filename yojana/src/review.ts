import {
  type Annotation,
  type ClaimResult,
  foldLog,
  isAnnotationOutdated,
  type StorePort,
} from '@cntxt-labs/yojana-core';
import type { StatusReport } from './status.ts';

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

function thread(
  annotations: readonly Annotation[],
  outdated: (a: Annotation) => boolean,
  when: (a: Annotation) => string,
): string {
  const replies = (id: string): Annotation[] => annotations.filter((a) => a.replyTo === id);
  const one = (a: Annotation, depth: number): string => {
    const badge = outdated(a)
      ? '<span class="pill warn" title="The requirement changed after this was written">outdated</span>'
      : '';
    const quote = a.quote === undefined ? '' : `<blockquote>${escapeHtml(a.quote)}</blockquote>`;
    const nested = replies(a.id)
      .map((r) => one(r, depth + 1))
      .join('');
    return `<li class="comment${depth > 0 ? ' reply' : ''}"><div class="who"><b>${escapeHtml(a.author)}</b> <span class="muted">${escapeHtml(when(a))} · ${escapeHtml(a.id)}</span> ${badge}</div>${quote}<p>${inline(a.body)}</p>${nested === '' ? '' : `<ul class="thread">${nested}</ul>`}</li>`;
  };
  const roots = annotations.filter(
    (a) => a.replyTo === undefined || !annotations.some((b) => b.id === a.replyTo),
  );
  return roots.length === 0
    ? ''
    : `<ul class="thread">${roots.map((a) => one(a, 0)).join('')}</ul>`;
}

export async function review(options: {
  readonly store: StorePort;
  readonly planId: string;
  readonly status: StatusReport;
  readonly checks?: readonly ClaimResult[] | undefined;
  readonly generatedAt: number;
}): Promise<string | undefined> {
  const state = foldLog(await options.store.events());
  const plan = state.plans.get(options.planId);
  if (plan === undefined) return undefined;
  const report = options.status.plans.find((p) => p.planId === plan.id);
  const atOf = new Map<string, number>();
  for (const event of await options.store.events()) {
    if (event.type === 'annotation-added') atOf.set(event.annotation.id, event.at);
  }
  const day = (ms: number | undefined) =>
    ms === undefined
      ? ''
      : new Date(ms).toISOString().slice(0, 'yyyy-mm-ddThh:mm'.length).replace('T', ' ');

  const sections = [...plan.heads.values()].map((requirement) => {
    const notes = plan.annotations.filter((a) => a.requirement === requirement.id);
    const current = notes.filter((a) => !isAnnotationOutdated(state, plan.id, a));
    const highlights = current.flatMap((a) => (a.quote === undefined ? [] : [a.quote]));
    const claims = (options.checks ?? []).filter((c) => c.requirement === requirement.id);
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
    const alignment = report?.alignment.find((a) => a.requirement === requirement.id);
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
    const comments = thread(
      notes,
      (a) => isAnnotationOutdated(state, plan.id, a),
      (a) => day(atOf.get(a.id)),
    );
    return `<section class="req" id="${escapeHtml(requirement.id)}">
  <header><h2>${inline(requirement.title)}</h2><a class="anchor" href="#${escapeHtml(requirement.id)}">#${escapeHtml(requirement.id)}</a></header>
  ${work.length > 0 ? `<div class="work">${work.join(' ')}</div>` : ''}
  ${flag}
  <div class="text">${renderMarkdown(requirement.text, highlights) || '<p class="muted">No text.</p>'}</div>
  ${claimList}
  ${comments === '' ? '' : `<div class="comments"><h3>Comments</h3>${comments}</div>`}
</section>`;
  });

  const progress = report?.progress;
  const progressText =
    progress === undefined || progress.error !== undefined
      ? ''
      : `<span>${progress.done}/${progress.total} work items done</span>`;
  const checks = options.checks ?? [];
  const tally = (o: ClaimResult['outcome']) => checks.filter((c) => c.outcome === o).length;
  const claimsText =
    checks.length === 0
      ? '<span>claims not checked</span>'
      : `<span>${tally('holds')} hold · ${tally('violated')} violated · ${tally('unverifiable')} not checked</span>`;
  const outdatedCount = plan.annotations.filter((a) =>
    isAnnotationOutdated(state, plan.id, a),
  ).length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(plan.id)} review</title>
<style>
:root { --bg:#f6f7f9; --surface:#fff; --ink:#1b2430; --muted:#5d6a78; --rule:#d9dfe6; --accent:#2f4f9e; --soft:#e7edf8; --ok:#2c7a4b; --bad:#b23a3a; --warn:#9a5a10; --mark:#fff1a8; color-scheme: light; }
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
</style>
</head>
<body>
<main>
  <div class="top">
    <h1>${escapeHtml(plan.id)}</h1>
    <div class="meta"><span>${escapeHtml(plan.status)}</span><span>${plan.heads.size} requirements</span>${progressText}${claimsText}<span>${plan.annotations.length} ${plan.annotations.length === 1 ? 'comment' : 'comments'}${outdatedCount > 0 ? ` (${outdatedCount} outdated)` : ''}</span><span>generated ${escapeHtml(day(options.generatedAt))} UTC</span></div>
  </div>
${sections.join('\n')}
</main>
</body>
</html>
`;
}
