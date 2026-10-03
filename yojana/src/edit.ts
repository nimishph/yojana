import { randomUUID } from 'node:crypto';
import {
  type BasePort,
  type ChangeDraft,
  foldLog,
  normalizeContent,
  type ParserPort,
  type Requirement,
  requirementRevision,
  type StorePort,
} from '@cntxt-labs/yojana-core';
import { renderChange } from '@cntxt-labs/yojana-markdown';
import { applyChange, openChange } from './changes.ts';
import { ingest, type PlanFile } from './ingest.ts';

/**
 * Edits from the review page. Two modes, both checked the way the CLI checks:
 *
 *   edit     rewrites one requirement in the plan file, then ingests it. Refused when the
 *            requirement has moved since the page showed it, or the plan file has edits that are
 *            not ingested yet (saving would sweep them in unseen).
 *   suggest  writes and opens a change file with the requirement as it should read, pinned to
 *            the revision the page showed. Accepting it is an ordinary archive.
 *
 * New text is re-parsed before anything is written, so text that would change the plan's
 * structure (a `## ` heading, a claim block) is refused rather than silently reshaping the plan.
 */

export type EditFailure =
  | { readonly ok: false; readonly code: 'NOT_FOUND' | 'PLAN_NOT_FOUND'; readonly message: string }
  | {
      readonly ok: false;
      readonly code: 'STALE';
      readonly message: string;
      /** The requirement as the log has it now, so the page can show what changed. */
      readonly current: Requirement;
    }
  | {
      readonly ok: false;
      readonly code: 'UNCHANGED' | 'INVALID_TEXT' | 'NO_PLAN_FILE' | 'FILE_NOT_IN_STEP';
      readonly message: string;
    };

export interface EditRequest {
  readonly store: StorePort;
  readonly planId: string;
  readonly requirementId: string;
  /** The revision the page showed; the edit is refused if the log has moved past it. */
  readonly expectedRevision: string;
  readonly title: string;
  readonly text: string;
  readonly actor: string;
}

async function current(request: EditRequest): Promise<Requirement | EditFailure> {
  const plan = foldLog(await request.store.events()).plans.get(request.planId);
  if (plan === undefined) {
    return { ok: false, code: 'PLAN_NOT_FOUND', message: `the log has no plan ${request.planId}` };
  }
  const head = plan.heads.get(request.requirementId);
  if (head === undefined) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: `${request.requirementId} is not a requirement of ${request.planId}`,
    };
  }
  if (head.revision !== request.expectedRevision) {
    return {
      ok: false,
      code: 'STALE',
      message: `${request.requirementId} changed since this page was loaded; nothing was saved`,
      current: head,
    };
  }
  return head;
}

function rewritten(head: Requirement, title: string, text: string): Requirement {
  const fields = {
    id: head.id,
    title: title.trim(),
    text: normalizeContent(text),
    claims: head.claims,
    ...(head.workItems === undefined ? {} : { workItems: head.workItems }),
  };
  return { ...fields, revision: requirementRevision(fields) };
}

export async function editRequirement(
  request: EditRequest & {
    readonly parser: ParserPort;
    readonly bases: BasePort;
    readonly files: readonly PlanFile[];
    readonly writePlan: (source: string, text: string) => void;
  },
): Promise<{ readonly ok: true; readonly revision: string } | EditFailure> {
  const head = await current(request);
  if ('ok' in head) return head;
  const next = rewritten(head, request.title, request.text);
  if (next.revision === head.revision) {
    return { ok: false, code: 'UNCHANGED', message: 'the requirement already reads like this' };
  }
  if (next.title === '') {
    return { ok: false, code: 'INVALID_TEXT', message: 'a requirement needs a title' };
  }

  const { parser, store, bases } = request;
  const dry = await ingest({
    store,
    parser,
    bases,
    files: request.files,
    actor: request.actor,
    dryRun: true,
  });
  const report = dry.files.find((f) => f.planId === request.planId);
  const file = request.files.find((f) => f.source === report?.source);
  if (report === undefined || file === undefined || report.outcome === 'invalid') {
    return {
      ok: false,
      code: 'NO_PLAN_FILE',
      message: `no readable plan file for ${request.planId}; use suggest instead`,
    };
  }
  const pending = report.requirements.map((r) => `${r.id} (${r.movement})`);
  if (pending.length > 0 || report.status !== undefined || report.workItemsChanged) {
    return {
      ok: false,
      code: 'FILE_NOT_IN_STEP',
      message: `${report.source} is not in step with the log${pending.length > 0 ? `: ${pending.join(', ')}` : ''}; run yojana ingest or refresh first, or suggest instead`,
    };
  }

  const parsed = parser.parse(file.source, file.text);
  if (!parsed.ok)
    return { ok: false, code: 'NO_PLAN_FILE', message: `${file.source} does not parse` };
  const text = parser.render(
    applyChange(parsed.plan, [{ op: 'modify', requirement: next, base: head.revision }]),
  );
  const check = parser.parse(file.source, text);
  const kept =
    check.ok &&
    check.plan.requirements.length === parsed.plan.requirements.length &&
    check.plan.requirements.some((r) => r.id === next.id && r.revision === next.revision);
  if (!kept) {
    return {
      ok: false,
      code: 'INVALID_TEXT',
      message:
        'the new text would change the plan structure (a ## heading or a claim block?); nothing was saved',
    };
  }

  request.writePlan(file.source, text);
  await ingest({
    store,
    parser,
    bases,
    files: request.files.map((f) => (f.source === file.source ? { ...f, text } : f)),
    actor: request.actor,
  });
  return { ok: true, revision: next.revision };
}

/** Characters of a random UUID in a suggestion's change id. */
const SUGGESTION_ID_CHARS = 6;
/** Room left for the requirement id inside a 64-character change id. */
const SUGGESTION_REQ_CHARS = 40;

export async function suggestEdit(
  request: EditRequest & {
    readonly parser: ParserPort;
    readonly why: string;
    /** Folder for change files, relative to the root (`changes`). */
    readonly changesDir: string;
    readonly writeChange: (source: string, text: string) => void;
  },
): Promise<
  { readonly ok: true; readonly changeId: string; readonly source: string } | EditFailure
> {
  const head = await current(request);
  if ('ok' in head) return head;
  const next = rewritten(head, request.title, request.text);
  if (next.revision === head.revision) {
    return { ok: false, code: 'UNCHANGED', message: 'the requirement already reads like this' };
  }

  const suffix = randomUUID().replaceAll('-', '').slice(0, SUGGESTION_ID_CHARS);
  const changeId = `suggest-${head.id.replace(/^req-/, '').slice(0, SUGGESTION_REQ_CHARS)}-${suffix}`;
  const source = `${request.changesDir}/${changeId}.md`;
  const draft: ChangeDraft = {
    id: changeId,
    planId: request.planId,
    title: `Suggested edit to ${head.id}`,
    deltas: [{ op: 'modify', requirement: next }],
    source,
  };
  const text = renderChange(draft, request.why);
  const check = request.parser.parseChange(source, text);
  const delta = check.ok ? check.change.deltas[0] : undefined;
  if (
    !check.ok ||
    check.change.deltas.length !== 1 ||
    delta?.op !== 'modify' ||
    delta.requirement.revision !== next.revision
  ) {
    return {
      ok: false,
      code: 'INVALID_TEXT',
      message:
        'the new text would change the plan structure (a ## heading or a claim block?); nothing was saved',
    };
  }

  request.writeChange(source, text);
  const opened = await openChange({
    store: request.store,
    draft: check.change,
    actor: request.actor,
  });
  if (opened.outcome !== 'opened') {
    return {
      ok: false,
      code: 'INVALID_TEXT',
      message: opened.problems.map((p) => p.message).join('; '),
    };
  }
  return { ok: true, changeId, source };
}
