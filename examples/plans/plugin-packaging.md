---
id: plan/plugin-packaging
title: Ship anvesa as a Claude Code plugin
status: accepted
beads: [anv-yp2]
---

# Ship anvesa as a Claude Code plugin

Why: anvesa has an MCP server and a skill, but users wire both up by hand.

## Requirement: plugin loads without a global install {#req-no-global}

The plugin's MCP server starts through `npx` when `anvesa` is not on PATH.

```yojana:claim
kind: wql
expression: //file[@path=".claude-plugin/plugin.json"]
expect: true
```

## Requirement: core stays independent of the CLI {#req-core-no-cli}

Nothing under `core/` imports from `cli/`.

```yojana:claim
kind: dependents
expression: cli/src/index.ts --from core/
expect: false
```
