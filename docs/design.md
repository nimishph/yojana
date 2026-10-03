# yojana design (v0)

**Plans as checkable contracts.** Status: v0 built and tested on anvesa, 2026-10-03.

## Why

The cntxt-labs tools each own one layer of an agent's working context:

| Tool | Layer | Answers |
|---|---|---|
| bd | execution | what to do next |
| medha | rules | what has proven true |
| anvesa | code | what the code actually is |
| **yojana** | **intent** | **what we decided, why, and whether the code still agrees** |

Plan files today rot: they sit in repo roots or `~/.claude/plans/` with no status, no link to the
work, and no way to tell which parts were built. OpenSpec is the closest existing tool. Its specs are
living files updated in place by deltas (git is the history), and archived changes are kept forever.
It does not handle abandoned changes, two changes editing the same requirement, or specs drifting
from the code. Yojana fills those three gaps.

## Principles

1. **Not a VCS.** Git versions files. Yojana versions meaning: which requirement changed, from which
   base revision, in which change, and why.
2. **Requirement-level revisions.** Every requirement has a stable id; each version of its text is a
   revision (`r_` plus 16 hex chars of the sha256 of the normalised text).
3. **Append-only log is the source of truth.** Plan files are the editing surface. Every state can be
   rebuilt by folding the log. This follows medha's episode log; the code is duplicated, not shared,
   until the pattern proves itself in both.
4. **Reports evidence, refuses ambiguity.** A conflict or a hand edit on a stale base is reported and
   refused, never resolved silently.
5. **Markdown is edited; HTML is reviewed.** People and agents edit plain Markdown. Review happens in
   a rendered HTML view with comments and highlights anchored to requirement revisions.

## File format

Markdown with YAML frontmatter. Requirements are `##` headings with an explicit id. Machine-readable
parts go in fenced `yojana:` blocks, which render as code on GitHub and parse without a JS compiler.

````markdown
---
id: plan/plugin-packaging
status: accepted          # draft | accepted | in-progress | realized | superseded | abandoned
beads: [anv-yp2]
---
## Requirement: plugin loads without a global install {#req-no-global}
The plugin's MCP server starts through npx when anvesa is not on PATH.

```yojana:claim
kind: path
expression: .claude-plugin/plugin.json
```
````

### Claims

`yojana check` runs every claim of every plan in the log. A claim **holds** when "something
matches" equals `expect` (default `true`), is **violated** otherwise, and is **unverifiable** when
the check cannot run (anvesa missing, no index, an invalid query, an unknown kind). Unverifiable
never counts as holding; `--strict` makes it fail the run.

| kind | expression | matches when |
|---|---|---|
| `path` | a path or glob from the repo root | a file exists |
| `wql` | `<wql> [in <dir>]` | anvesa's query matches, only in files under `<dir>` if given |
| `dependents` | `<path> [from <dir>]` | something imports `<path>`, only importers under `<dir>` if given |

A scoped claim's evidence also states how many matched overall, so a check that passes only
because nothing matches anywhere is visible.

Prefer claims that name the work over claims that a place exists: `crates/anvesa-napi/Cargo.toml`
exists before any SIMD code does, while `//function[@name="batch_scan_top_k"] in crates/` holds
only once it is written. Boundaries read the same way: `//import[contains(@name, "cli/src")] in
core/` with `expect: false` says the core never imports the CLI.

MDX is not an editing format. Agents edit it less reliably and it needs a compiler. It may come back
later as a render-only adapter.

## Lifecycle

`draft → accepted → in-progress → realized`, or at any point `superseded` / `abandoned`. Every
transition is an event with an actor and a reason. Progress is derived from linked beads, never
typed in. An open change older than a set number of days (default 14) is reported as stale.

## Changes and conflicts

A change is a set of deltas (`add`, `modify`, `remove`), each recorded against the base revision it
started from. `archive` uses optimistic concurrency:

- an `add` conflicts if the id already exists;
- a `modify` or `remove` conflicts if the requirement's current revision is not the delta's base.

Conflicts block the archive and name the requirement, the expected revision and the actual one.
The check is `findBaseConflicts` in `yojana-core`.

Change files sit in `changes/` and use `## ADDED`, `## MODIFIED` and `## REMOVED Requirement:`
sections. `yojana change open` pins each edit to the requirement's current revision; `archive`
applies it, rewriting the plan file only when that file is in step with the log, and moves the
change file to `changes/archive/<date>-<id>.md`; `abandon --reason` moves it to
`changes/abandoned/`.

## Ports and adapters

| Port | Job | v0 | Later |
|---|---|---|---|
| StorePort | local append-only revision log | memory, JSONL file | SQLite |
| SyncPort | copy the log elsewhere | noop, file bundle | git ref (`refs/yojana/*`), Dolt, HTTP/S3 |
| ParserPort | files ⇄ plans | Markdown | OpenSpec import/export, HTML review renderer, MDX render |
| VerifierPort | check claims against code | anvesa (`wql`, `dependents`), filesystem (`path`) | text, shell command |
| WorkLinkPort | plan ⇄ execution | bd | others |
| RuleSink | proven decisions → rules | — | medha `propose` |

Store and sync are separate ports so a remote never becomes a second source of truth.

## Packages

```
yojana-core      domain model, ports, conflict check (no dependencies)
yojana-store     StorePort backends
yojana-sync      SyncPort adapters
yojana-markdown  ParserPort adapter (plans and change files)
yojana-verify    VerifierPort adapters: anvesa, path
yojana-work      WorkLinkPort adapter: bd
yojana           engine: ingest, changes, check, status, refresh
cli              the yojana command
```

Boundaries are enforced by dependency-cruiser: the graph points one way, and packages import each
other only through `src/index.ts`.

## Keeping files and log in step

`yojana ingest` records edits to plan files. To tell an edit from a file that has fallen behind, it
keeps a **base** per plan (`.yojana/base/<plan>.jsonl`, committed with the plans): the revision of
each requirement the last time the file and the log agreed, much like git's index. Each requirement,
and the plan's status, is compared three ways:

| file vs base vs log | meaning | ingest does |
|---|---|---|
| file = log | in step | nothing |
| base = log, file differs | the file was edited | records it on top of the log |
| file = base, log differs | the log moved, the file did not | reports the file as behind |
| all three differ | both moved | refuses the whole file, records nothing |

A plan is ingested all or nothing, and re-running with no edits appends nothing. If a base is lost
for a plan the log already knows, differing requirements are refused unless `--trust-file` says to
record the file on top of the log. A Claude Code PostToolUse hook on edits under `plans/` can run
ingest automatically.

`yojana refresh` goes the other way: it rewrites only the requirements a file is behind on (they
still match the base, so nothing is lost), keeps edits not yet ingested, and moves the base only
for what it refreshed. `yojana repair` handles a corrupt log: it keeps every readable event and
moves the rest to a side file.

## Status

`yojana status [plan] [--check]` shows, per plan: lifecycle status and since when; progress read
from its beads (an epic counts its children, a missing bead counts as not done, an unreachable bd
is reported, never shown as 0%); the plan file against the log, from a dry-run ingest (edits not
ingested, requirements it is behind on, conflicts); contested requirements; open changes with
their age (stale after `--stale-days`, default 14); and anomalies still needing attention. A merge
collision is marked settled once resolved and drops out of status, staying in the log as history.
`--check` adds the claim results. Plan files that do not parse, or name a plan the log does not
know, are listed as untracked with the reason.

## Branches and merges

The log and the bases are committed with the plans, so two branches can each record edits. Both
files hold one fact per line, and yojana writes `.yojana/.gitattributes` so git merges them by
keeping both sides' lines (`merge=union`):

- **Log.** Each event carries a content id (`eventId`) and no stored position; order is line order.
  A merged log reads as one log. A repeated event id, or a line that is not an event, is corruption.
- **Bases.** A header line, then one line per requirement; when a line repeats after a merge, the
  last one wins.
- **Different requirements edited on two branches** merge with no manual step and no anomaly.
- **The same requirement edited on both** leaves it *contested* in the fold: two edits written
  against the same revision. The plan file has an ordinary git conflict there. Ingest refuses a
  file that still has conflict markers; once a person resolves it, ingest records the file's
  version on top of the log (`resolved`), which settles the contest.

## Review surface

The HTML renderer turns a plan into a review page: requirements, claim results, linked bead status,
and comment threads. A comment is an `annotation-added` event anchored to a requirement id and
revision (optionally a quoted span). When that requirement gets a new revision the comment shows as
outdated rather than disappearing or silently re-attaching.

## Commands

```
yojana ingest [--trust-file]              record edits to plan files
yojana change open <file>                 open a change file against the log
yojana changes [--all]                    list changes
yojana archive <change>                   apply a change if what it edits has not moved
yojana abandon <change> --reason <text>   close a change without applying it
yojana refresh                            bring log changes into plan files that fell behind
yojana status [plan] [--check]            plans, progress, pending edits, open changes
yojana check [plan] [--strict]            verify claims against the code
yojana repair                             recover a corrupt log
```

Every command takes `--json`, including for errors. Exit codes: 0 done; 1 refused, violated,
invalid or failed; 2 usage.

## What v0 delivered, and what is next

Built and tested on two clones of anvesa: the parser, the merge-safe log, ingest with bases,
changes, claim checks through anvesa, progress from bd, status, refresh and repair.

Dogfooding anvesa's own roadmap found that 7 of its 8 claims already hold in the code while all 7
beads were still open. Next, from that run: link each requirement to its work items so status can
flag "claims hold, bead open" (yoj-nw5); a `text` claim kind for strings in files (yoj-zuq); an
importer for existing roadmaps (yoj-04r). Later: the HTML review renderer (yoj-djd), OpenSpec
import/export, git-ref and Dolt sync, a medha rule sink, and a Claude Code plugin.
