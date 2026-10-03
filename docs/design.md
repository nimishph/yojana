# yojana design (v0)

**Plans as checkable contracts.** Status: draft, 2026-10-03.

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
kind: wql
expression: //file[@path=".claude-plugin/plugin.json"]
expect: true
```
````

MDX is not an editing format. Agents edit it less reliably and it needs a compiler. It may come back
later as a render-only adapter.

## Lifecycle

`draft → accepted → in-progress → realized`, or at any point `superseded` / `abandoned`. Every
transition is an event with an actor and a reason. Progress is derived from linked beads, never
typed in. A change whose beads have not moved for a configurable period is reported as stale.

## Changes and conflicts

A change is a set of deltas (`add`, `modify`, `remove`), each recorded against the base revision it
started from. `archive` uses optimistic concurrency:

- an `add` conflicts if the id already exists;
- a `modify` or `remove` conflicts if the requirement's current revision is not the delta's base.

Conflicts block the archive and name the requirement, the expected revision and the actual one.
The check is `findBaseConflicts` in `yojana-core`.

## Ports and adapters

| Port | Job | v0 | Later |
|---|---|---|---|
| StorePort | local append-only revision log | memory, JSONL file | SQLite |
| SyncPort | copy the log elsewhere | noop, file bundle | git ref (`refs/yojana/*`), Dolt, HTTP/S3 |
| ParserPort | files ⇄ plans | Markdown | OpenSpec import/export, HTML review renderer, MDX render |
| VerifierPort | check claims against code | anvesa (`wql`, `dependents`) | shell command |
| WorkLinkPort | plan ⇄ execution | bd | others |
| RuleSink | proven decisions → rules | — | medha `propose` |

Store and sync are separate ports so a remote never becomes a second source of truth.

## Packages

```
yojana-core      domain model, ports, conflict check (no dependencies)
yojana-store     StorePort backends
yojana-sync      SyncPort adapters
yojana-markdown  ParserPort adapter
yojana           engine facade: ingest, status, archive, check
cli              the yojana command
```

Boundaries are enforced by dependency-cruiser: the graph points one way, and packages import each
other only through `src/index.ts`.

## Keeping files and log in step

`yojana ingest` records edits to plan files. To tell an edit from a file that has fallen behind, it
keeps a **base** per plan (`.yojana/base/<plan>.json`, committed with the plans): the revision of
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
ingest automatically. The file can always be regenerated from the log.

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

## v0 scope

1. Markdown parser with requirement ids and claims; JSONL store plus a contract suite
2. `ingest`, `status`, and `archive` with the base-revision conflict check
3. `check` through the anvesa verifier
4. bd work link: accepting a plan files beads; status reads them back

After v0: OpenSpec import/export, HTML review renderer with annotations, git-ref and Dolt sync,
medha rule sink, Claude Code plugin.
