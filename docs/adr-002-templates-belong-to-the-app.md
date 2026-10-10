# ADR-002: Templates belong to the app; patra is the engine

Status: accepted, 2026-10-09. Supersedes the **Templates** part of [ADR-001](adr-001-patra-split.md);
the rest of ADR-001 stands. Implementation: epic in yojana's beads (see below).

## Context

ADR-001 moved presentation out of yojana and into patra, with the question "does this code know
what a plan is?". It put the review page's template, `review-document`, in patra too, on the
grounds that "none of that page is specific to plans" and other tools would reuse it.

In practice the template is shaped by plans: an outline of requirements, a document of
requirement sections with claims and work items, a rail of threads and changes. How a plan reads
(which columns stay in view, how claims and action items show, what the outline lists) is
yojana's product decision, but every such change had to be filed and released in patra. The first
one, keeping the requirement list and comments in view while the body scrolls, was filed in patra
(pat-lk7), not where the people who use and decide it work.

The engine never needed the template to live in patra: `loadTemplate(dir)` accepts any directory.
yojana only reaches into patra for its folder (`templateDir('review-document')` from
`@cntxt-labs/patra-templates`).

## Decision

**patra is the engine**: a generic, domain-free layer over htmx that apps build their pages with.
It owns:

- **core**: loading and validating a template (manifest, parts, content schema) from a directory
  the app gives it, and rendering a page or one part from content;
- **serve**: the local server, the intent API (`{action, target, payload, version}` →
  `{ok, content}` or `{refused, code, message}`), htmx wiring, forms, the selection toolbar,
  keyboard, partial updates;
- **themes**: tokens and the default light and dark theme;
- **building blocks** that are generic in fact, not in hope: parts and CSS a second app actually
  reuses (a pane layout, a comment thread, a diff). They move into patra when a second app needs
  them, not before.

**The app owns its templates.** yojana keeps the plan review template (`plan-review`, renamed from
`review-document`) in its own repo: page structure, parts, CSS and layout, and its content
schema. The projector and the intent handler stay as ADR-001 describes them, now next to the
template they fill.

patra ships no app pages. Its examples carry their own small templates.

## Consequences

- The template, its content schema and its tests move from `patra/templates/review-document` to
  yojana; `cli/src/serve.ts` loads it from yojana's folder, and the plugin bundle
  (`claude-plugin/lib`) ships it.
- yojana's review page changes (layout, sticky columns, action items, claim display) are filed,
  built and released in yojana alone. pat-lk7 is closed in patra and refiled in yojana.
- patra drops `@cntxt-labs/patra-templates` and `templateDir`. Its tests and the notes-app example
  use their own minimal template, which also proves loading from an app's directory works.
- The content schema is no longer a contract published by patra: it is yojana's, versioned with
  yojana, and patra validates content against whatever schema the template declares.
- Cost: another tool that wants a review page cannot take yojana's whole. It composes patra's
  engine and building blocks into its own template, and anything it would copy from yojana is a
  candidate to become a patra building block. Accepted: a page shaped around requirements was
  never generic, and keeping it in patra put yojana's product decisions in the wrong repo.
