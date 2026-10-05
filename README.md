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
> Pre-release: the commands work and are tested, but the log format and commands may still change.
> See [docs/design.md](docs/design.md) and [examples/plans](examples/plans).

## Claude Code plugin

[`claude-plugin/`](claude-plugin) makes yojana available inside Claude Code:

- the `yojana` skill: plan and change file formats, commands, and the rule that Claude proposes
  (suggested changes, `yojana decide`, `yojana propose-status`) while the person decides: only a
  person accepts a plan, moves its status, or approves or declines a requirement;
- `/yojana:plan <what>` drafts a plan with checkable claims; `/yojana:review` opens the live
  review pages;
- a `yojana` command on Claude's PATH that records its actions as `claude` (pages served by
  `review --serve` still record the person);
- a SessionStart hook that points the session at the plugin's `yojana.config.json` (see
  Customize), and, in a repository with `.yojana/`, tells Claude so and lists open changes and
  decisions waiting on a person (log only; it never calls bd or anvesa).

It needs [Bun](https://bun.sh) on the PATH, and nothing else: the CLI is bundled in
`claude-plugin/lib/`. In Claude Code:

```
/plugin marketplace add nimishph/cntxt-labs
/plugin install yojana@cntxt-labs
```

To run a checkout instead of the bundle (while developing yojana), set `YOJANA_HOME` to it, for
example in `~/.claude/settings.json`, or `home` in the plugin's `yojana.config.json` (below):

```json
{ "env": { "YOJANA_HOME": "/path/to/yojana" } }
```

`YOJANA_HOME` wins over `home`. Running in place (`claude --plugin-dir claude-plugin`) uses the
checkout's source. After changing the CLI or taking a newer patra, run `bun run bundle`;
`bun run check` fails while `claude-plugin/lib/` is out of date.

### Customize: `yojana.config.json`

Each installation of the plugin has one `yojana.config.json`, in the plugin's data folder
(`~/.claude/plugins/data/<plugin>/`), which plugin updates leave alone. At session start the
plugin points `YOJANA_CONFIG` at it, so `yojana config` shows where it is and what is in effect.
Every setting is optional, and so is the file:

```json
{
  "vars": { "sutras": "~/code/sutras" },
  "home": "${sutras}/yojana",
  "theme": {
    "css": "./my-theme.css",
    "fonts": { "reading": "Charter, Georgia, serif", "ui": "Inter, system-ui, sans-serif" },
    "tokens": { "intent-primary": "#5b3cc4", "radius-md": "6px" },
    "dark": { "intent-primary": "#b7a6f5" }
  }
}
```

| Setting | What it does |
| --- | --- |
| `vars` | path variables, usable as `${name}` in any path below (and in later vars) |
| `home` | a yojana checkout to run instead of the bundled CLI, when `YOJANA_HOME` is not set |
| `theme.css` | a stylesheet that replaces patra's default theme; it must define the same tokens |
| `theme.fonts` | font families for `reading` (plan text), `ui` (controls) and `mono` (ids, code) |
| `theme.tokens` | theme tokens, light mode, and every mode for tokens the theme sets once (fonts, radii) |
| `theme.dark` | colour tokens for dark mode, whether the viewer prefers it or chose it |

- **Paths:** they take `${name}` from `vars`, then from the environment, and expand a leading
  `~`. A relative path is relative to the config file.
- **Tokens:** names are patra's, with or without the leading `--`:
  - surfaces: `surface-page`, `surface-raised`, `surface-sunken`;
  - text and lines: `text`, `text-muted`, `border`;
  - intents: `intent-neutral|primary|success|warning|danger`, each with a `-soft` variant;
  - reading aids: `mark`, `diff-insert`, `diff-delete`;
  - shapes: `radius-sm`, `radius-md`, `radius-pill`.
- **Mistakes:** an unknown setting, a variable that isn't set, a missing theme file, or a value
  that isn't plain CSS stops `yojana review` with `CONFIG_INVALID`, saying what to fix.
- **When changes apply:** theme settings apply to the next review page written or served.
  `home` applies from the next Claude Code session.
- **Outside Claude Code:** set `YOJANA_CONFIG` to any file. For a single run, `YOJANA_THEME_CSS`
  names a stylesheet placed before the theme, such as one with font `@import` lines.

## opencode plugin

[`opencode-plugin/`](opencode-plugin) gives opencode the same parts, shared with the Claude Code
plugin rather than copied:
- the `yojana` skill;
- `/yojana-plan <what>` and `/yojana-review`;
- `yojana` in opencode's shell, recording its actions as `opencode`;
- at the start of a session in a repository with `.yojana/`, the same note on open changes and
  pending decisions.

opencode runs a plugin from a path, so it runs in place from this checkout and needs no
`YOJANA_HOME`. Set up the checkout (see Develop), then add it to `opencode.json` (yours in
`~/.config/opencode/`, or a project's):

```json
{
  "plugin": [["/path/to/yojana/opencode-plugin", { "config": "~/.config/opencode/yojana.config.json" }]]
}
```

| Option | Default | What it does |
| --- | --- | --- |
| `config` | `~/.config/opencode/yojana.config.json` | the `yojana.config.json` to use (see Customize; its `home` is not needed here) |
| `agent` | `opencode` | the name the log records for what the agent does |

An environment variable that is already set (`YOJANA_CONFIG`, `YOJANA_HOME`, `YOJANA_AGENT`) wins
over the option. The session note uses opencode's `experimental.chat.system.transform` hook, which
may change between opencode versions.

## Develop

The review page is drawn by [patra](../patra) (see [ADR-001](docs/adr-001-patra-split.md)), a
sibling repository that is not published. Its packages are vendored as tarballs in
[`vendor/patra/`](vendor/patra), packed from the patra commit named in `vendor/patra/COMMIT`, so
`bun install` needs no patra checkout. To take a newer patra, commit it there, then:

```sh
sh tooling/vendor-patra.sh   # packs ../patra (or the path given) into vendor/patra/
bun install --force         # the tarball names do not change; --force skips the cached copy
```

```sh
bun install
bun run check      # lint, typecheck, package boundaries, tests
bun cli/src/main.ts --help
```

## License

MIT
