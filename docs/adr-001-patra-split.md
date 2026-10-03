# ADR-001: Presentation moves to patra; yojana keeps the meaning

Status: accepted, 2026-10-03. Implementation: epic in yojana's beads (see below).

## Context

`yojana review --serve` grew a full presentation layer inside yojana: HTML for the review page,
forms, a selection toolbar, htmx wiring, and an HTTP server. The design review that followed
(docs: "Yojana Review Surface" proposal) settled what the page should be: a long spec document
with an outline and a review rail, Read / Suggest / Edit modes, threads pinned to quotes, changes
as diffs with Accept / Reject.

None of that page is specific to plans. Medha's rule review, anvesa's reports, inkwell's digests
and tools outside the sutras need the same kind of surface. Keeping it in yojana would mean every
tool grows its own, and yojana's domain code would keep mixing with markup.

## Decision

Split by one question: **does this code know what a plan is?**

**patra** (separate repo, shared across the sutras and usable outside them) owns presentation and
interaction, and knows nothing about any domain:

- **Templates**: HTML with placeholders and named parts that can be re-rendered on their own, plus
  a `theme.css` of tokens. Each template declares the content schema it accepts.
- **Render**: `(templateId, content)` → page, or `(templateId, partId, content)` → fragment.
- **Interaction**: modes, selection toolbar, forms, keyboard, partial updates (htmx). A person's
  action becomes an **intent** `{action, target, payload, version}` sent to the app that owns the
  content. The app answers `{ok, content}` for the affected part, or `{refused, code, message}`,
  and patra re-renders or shows the reason with the person's input kept.
- **Version is opaque**: patra hands each part's `version` back with every intent and never
  interprets it.
- **Hosting**: a local server first; static export and publishing as a claude.ai artifact later.

**yojana** keeps everything that knows what a plan means: the plan model, the revision log and
fold, ingest with bases, refresh and repair, changes with pinned bases, claim checks, the work
port, status and alignment, import, annotation semantics (anchored to a revision, outdated when it
moves), decisions, and the CLI. It gains two thin pieces:

- a **projector**: fold state → content JSON for a generic review-document template;
- an **intent handler**: patra intents → yojana commands, with all the existing checks. The
  requirement revision travels as patra's opaque `version`, so staleness stays yojana's call.

### Decisions on work items (outbox)

Closing a bead from the page is recorded, not executed on the spot:

1. `decision-recorded` {target work item, action (close), reason, by} — state **proposed**.
2. `decision-finalized` — by the person, from the page or the CLI.
3. An apply step calls `WorkLinkPort.close(id, reason)`; bd's adapter runs `bd close`. Outcome is
   recorded as `decision-applied` or `decision-failed` with the tracker's message.

yojana never calls bd directly; bd is one adapter behind the port. Failures stay visible.
Applying is idempotent: closing an item that is already closed counts as applied.

### Scope now

- One reviewer and Claude. Sharing (claude.ai artifact, its native comments) is a later
  extension, not a v1 requirement.
- Map / canvas view after the document view settles.
- auix is not a dependency of patra v0. Templates name their small parts in auix's vocabulary
  (`chip`, `button`, `alert`; `intent: success | danger | warning`) so an auix style adapter can
  replace the default theme later without template changes.

## Consequences

- `review.ts`, `review-live.ts` and the htmx parts of `cli/src/serve.ts` move to patra; yojana's
  review code shrinks to the projector and the intent handler.
- The content contract becomes a published, versioned schema: changing it is a deliberate act in
  patra, and yojana's projector is tested against it.
- Other tools get a review surface by writing a projector and an intent handler, not a UI.
- One more repo to release. Accepted: the alternative is a UI per tool.
