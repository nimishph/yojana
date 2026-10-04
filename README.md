# yojana

**Plans as checkable contracts.**

Plan files rot. They pile up with no status, no link to the work, and no way to tell whether the
code still matches what was decided. Yojana keeps plans as plain Markdown that you and your agents
edit, and records every change to every requirement in an append-only log. From that it can say:

- which requirements changed, from which revision, in which change, and why;
- when two changes edit the same requirement (archive refuses instead of overwriting);
- which claims in a plan the code no longer satisfies (checked with [anvesa](https://github.com/nimishph/anvesa));
- how far along a plan is, read from its [beads](https://github.com/steveyegge/beads), never typed in.

It is part of the cntxt-labs set: **bd** for work, **medha** for rules, **anvesa** for code,
**yojana** for intent.

> [!NOTE]
> Pre-release. The domain model, ports and conflict check exist; the commands are being built.
> See [docs/design.md](docs/design.md) and [examples/plans](examples/plans).

## Claude Code plugin

[`claude-plugin/`](claude-plugin) makes yojana available inside Claude Code:

- the `yojana` skill: plan and change file formats, commands, and the rule that Claude proposes
  (suggested changes, `yojana decide`) while the person decides;
- `/yojana:plan <what>` drafts a plan with checkable claims; `/yojana:review` opens the live
  review pages;
- a `yojana` command on Claude's PATH that records its actions as `claude` (pages served by
  `review --serve` still record the person);
- a SessionStart hook that, in a repository with `.yojana/`, tells Claude so and lists open
  changes and decisions waiting on a person (log only; it never calls bd or anvesa).

It runs the CLI from a checkout, so set up the checkout first (see Develop), then in Claude
Code:

```
/plugin marketplace add <path to this repository>
/plugin install yojana@yojana
```

An installed plugin is a copy of `claude-plugin/` alone, so tell it where the checkout is with
`YOJANA_HOME`, for example in `~/.claude/settings.json`:

```json
{ "env": { "YOJANA_HOME": "/path/to/yojana" } }
```

Without `YOJANA_HOME`, `yojana` works only when the plugin runs in place:
`claude --plugin-dir claude-plugin`.

## Develop

The review page is drawn by [patra](../patra) (see [ADR-001](docs/adr-001-patra-split.md)), a
sibling repository that is not published. Its packages are vendored as tarballs in
[`vendor/patra/`](vendor/patra), packed from the patra commit named in `vendor/patra/COMMIT`, so
`bun install` needs no patra checkout. To take a newer patra, commit it there, then:

```sh
sh tooling/vendor-patra.sh   # packs ../patra (or the path given) into vendor/patra/
bun install
```

```sh
bun install
bun run check      # lint, typecheck, package boundaries, tests
bun cli/src/main.ts --help
```

## License

MIT
