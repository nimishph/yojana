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

## Develop

```sh
bun install
bun run check      # lint, typecheck, package boundaries, tests
bun cli/src/main.ts --help
```

## License

MIT
