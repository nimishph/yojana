---
name: plan
description: Draft a yojana plan for the work being discussed, as requirements with checkable claims, and record it in the log.
argument-hint: "<what the plan is for>"
disable-model-invocation: true
---

# Draft a plan

Write a plan for: $ARGUMENTS

Read the `yojana` skill first for the file format and the rules.

1. Understand the work: what changes, where in the code, and what "done" looks like. Look at
   the code before writing claims, so every path and name in a claim is real.
2. Write `plans/<short-name>.md` with `status: draft`:
   - a short intro: why, and what is out of scope;
   - one `## Requirement:` per outcome a reviewer can check on its own, each with a stable id
     (`{#req-...}`), not one per task;
   - at least one claim per requirement where the code can show it. Where it cannot, say so in
     the text rather than inventing a claim;
   - `beads=` links, if bd items exist for the work. Do not create beads unless asked.
3. Run `yojana ingest`, then `yojana check plan/<short-name>`. Some claims about work not done
   yet are expected to fail; anything that fails because the claim itself is wrong, fix now.
4. Show the person the requirements and which claims already hold, and offer `/yojana:review`
   to read and comment on it in the browser. The plan stays `draft` until they accept it.
