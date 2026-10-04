---
name: yojana
description: Plans as checkable contracts. Use when planning non-trivial work, writing or changing a plan file (plans/*.md), checking whether a plan still holds against the code, reviewing a plan with the user, or deciding that a bead (work item) is done. Also use when a repository has a .yojana/ folder.
---

# yojana: plans as checkable contracts

A yojana plan is a Markdown file of **requirements**. Each requirement can carry **claims**,
statements about the code that yojana checks (a path exists, a pattern is gone, core never
imports the CLI). Every edit is kept in an append-only log (`.yojana/log.jsonl`), so a plan has
a history, its comments stay pinned to the text they were about, and its claims say whether the
plan still matches the code.

`yojana` is on your PATH through this plugin. It acts as you, the agent (`claude`), so the log
shows what you did and what the person did.

## The working rule: you propose, the person decides

- **Plan text.** You may write and edit a plan while it is `draft`. Once it is `accepted` or
  later, suggest instead: write a change file and open it, so the person sees a diff and accepts
  or rejects it. Edit an accepted plan directly only when the person asks you to.
- **Work items.** Never close or reopen a bead yourself because a plan says the work is done.
  Propose it with `yojana decide` (without `--final`). The person finalizes it on the review page
  or with `yojana decisions --finalize`. Only then does `yojana decisions --apply` run `bd close`.
  Do not pass `--final` or run `--apply` unless the person asks in this conversation.
- **The log.** Never edit `.yojana/` by hand. It is written only by `yojana`.

## A plan file

~~~markdown
---
id: plan/search-explains
status: draft            # draft | accepted | in-progress | realized | superseded | abandoned
beads: [anv-12]          # optional: the plan's work items (bd ids)
---

# Search that explains itself

Free prose: why, context, design notes. Kept as written.

## Requirement: every hit says why it matched {#req-reasons beads=anv-12.1}

Results carry a reason. A hit without one is a bug.

```yojana:claim
kind: wql
expression: //function[@name="explainHit"] in src/
```

## Requirement: the old ranker is gone {#req-no-old-ranker}

```yojana:claim
kind: text
expression: /oldRank\(/ in src/**/*.ts
expect: false
```
~~~

- `## Requirement: <title> {#id}`: the id is stable. Never reuse or renumber ids. `beads=a,b`
  links work items to this requirement.
- Claims, one fenced `yojana:claim` block each, `expect: true` by default:

  | kind | expression | holds when |
  | --- | --- | --- |
  | `path` | `README.md` | the file or folder exists |
  | `text` | `pattern in path-or-glob` (`/re/flags` for a regex) | some line matches |
  | `wql` | anvesa WQL, optionally `in <dir>` | the query matches something |
  | `dependents` | `<path> [from <dir>]` | something imports the path |

  With `expect: false` the claim holds when nothing matches. Write claims that a reader can
  trust: specific paths and names, not "the code is good".

## Commands

| What | Command |
| --- | --- |
| record edits to plan files in the log | `yojana ingest` |
| plans, progress, pending edits, open changes | `yojana status [plan] [--check]` |
| check claims against the code | `yojana check [plan]` |
| open a suggested change | write `changes/<id>.md`, then `yojana change open changes/<id>.md` |
| list, accept, reject changes | `yojana changes`, `yojana archive <id>`, `yojana abandon <id> --reason "…"` |
| comment on a requirement | `yojana comment <plan> <req> "text" [--quote "span"] [--reply <id>]` |
| propose a decision on a bead | `yojana decide <plan> <req> <bead> close\|reopen --reason "…"` |
| decisions waiting, and their outcomes | `yojana decisions [--all]` |
| bring log edits back into plan files | `yojana refresh` |
| start a plan from an existing roadmap | `yojana import <file> --id plan/<name>` |
| review page in the browser | the `/yojana:review` skill |
| settings in effect, and where the config file is | `yojana config` |

Add `--json` for machine-readable output. Exit code 1 means refused, violated or failed; the
output says which.

After you edit a plan file, run `yojana ingest`. If it reports a conflict, someone else changed
that requirement since; read `yojana status` and ask the person rather than forcing it.

## A change file

~~~markdown
---
id: suggest-reasons-wording
plan: plan/search-explains
title: Name what a reason contains
---

Why: "a reason" was too vague to check.

## MODIFIED Requirement: every hit says why it matched {#req-reasons beads=anv-12.1}

Results carry a reason naming the field and the query term that matched.

## ADDED Requirement: reasons are tested {#req-reasons-tested}

## REMOVED Requirement: the old ranker is gone {#req-no-old-ranker}

Done in anv-12.3; nothing left to check.
~~~

A MODIFIED or ADDED section is the requirement as it should read afterwards, claims included.
`yojana change open` pins it to the current text, so if the plan moves first, accepting it is
refused rather than overwriting someone's edit.

## Settings: yojana.config.json

The person can customize yojana for this installation in `yojana.config.json`. The file lives at
`$YOJANA_CONFIG`, in the plugin's data folder, which plugin updates keep. When they ask to change
the review page's look or where yojana runs from, edit that file for them (create it if missing),
then run `yojana config` to confirm it reads. Every key is optional:

```json
{
  "vars": { "sutras": "~/code/sutras" },
  "home": "${sutras}/yojana",
  "theme": {
    "css": "./my-theme.css",
    "fonts": { "reading": "Charter, Georgia, serif", "ui": "Inter, sans-serif", "mono": "JetBrains Mono, monospace" },
    "tokens": { "intent-primary": "#5b3cc4", "radius-md": "6px" },
    "dark": { "intent-primary": "#b7a6f5" }
  }
}
```

- `vars` are path variables. Every path (`home`, `theme.css`, later vars) takes `${name}` from
  them, then from the environment, a leading `~`, and is relative to the config file.
- `home` is the yojana checkout. `YOJANA_HOME`, if set, wins; a change applies next session.
- `theme.css` replaces patra's default theme. `fonts` sets `reading`, `ui` and `mono`. `tokens`
  are light mode (and every mode for tokens set once, like radii); `dark` is dark mode.
- Tokens: `surface-page|raised|sunken`, `text`, `text-muted`, `border`,
  `intent-neutral|primary|success|warning|danger` and each `-soft`, `mark`, `diff-insert`,
  `diff-delete`, `radius-sm|md|pill`. Values are plain CSS, without `;`, braces, `<`, `>` or `\`.
- Unknown keys and bad values are refused (`CONFIG_INVALID`), not ignored. A running
  `review --serve` keeps its theme; restart it to see changes.

## When claims and work disagree

`yojana status --check` flags two mismatches. **close?**: every claim holds but a linked bead
is open. Propose closing it. **reopen?**: the bead is closed but a claim is violated. Tell the
person, and propose reopening or fix the code.
