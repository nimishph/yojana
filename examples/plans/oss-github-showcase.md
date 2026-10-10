---
id: plan/oss-github-showcase
title: GitHub CLI Integration Plan
status: in-progress
issues:
  - cli/cli#100
  - cli/cli#14618
  - cli/cli#14621
---

# GitHub CLI Integration Plan

Demonstrates tracking progress live from real open-source GitHub issues on [cli/cli](https://github.com/cli/cli) alongside checkable codebase claims.

## Requirement: Terminal documentation and manual pages {#req-manpage}

Documentation must be available directly in terminal environments.

```yojana:claim
kind: path
expression: README.md
expect: true
```

### Actions
- Initial manpage generation {#act-manpage issue=cli/cli#100}

## Requirement: Pull Request Sharing Workflow {#req-pr-share}

Users need a first-class workflow to share pull request links or reviews with collaborators.

### Actions
- Add `gh pr share` command {#act-pr-share issue=cli/cli#14618}
- Clarify `gh` skill description for agent workflows {#act-skill-desc issue=cli/cli#14621}
