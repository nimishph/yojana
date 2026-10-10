---
id: plan/markdown-checklist
title: Plain-Markdown Checklist Progress
status: in-progress
---

# Plain-Markdown Checklist Progress

Demonstrating progress tracking with no external tools: `- [x]` items under requirements automatically count as done.

## Requirement: Fast local search {#req-search}

Search must index files quickly and return ranked results.

### Actions
- [x] In-memory reverse index {#act-index}
  ```yojana:claim
  kind: path
  expression: yojana-work/src/checklist.ts
  ```
- [ ] Fuzzy matching with typo tolerance {#act-fuzzy}
- [x] Ranking by relevance {#act-rank}

## Requirement: Zero-dependency deployment {#req-zero-dep}

The core engine runs anywhere without external CLI dependencies.

- [x] Pure TypeScript domain models
- [x] Plain-Markdown checklist adapter
