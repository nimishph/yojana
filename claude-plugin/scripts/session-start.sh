#!/usr/bin/env sh
# SessionStart: in a repository that keeps yojana plans, tell Claude so, and what waits on a
# person (open changes, decisions on beads). Reads the log only, never bd or anvesa, so it is fast.
root="${CLAUDE_PROJECT_DIR:-$PWD}"
[ -f "$root/.yojana/log.jsonl" ] || exit 0
yojana="$(dirname "$0")/../bin/yojana"

echo "This repository keeps yojana plans (log in .yojana/). Use the yojana skill before planning, or before changing a plan or a bead it links."
changes="$("$yojana" changes --root "$root" 2>/dev/null)"
if [ -n "$changes" ] && [ "$changes" != "no open changes" ]; then
  printf 'Open changes waiting for review:\n%s\n' "$changes"
fi
decisions="$("$yojana" decisions --root "$root" 2>/dev/null)"
if [ -n "$decisions" ] && [ "$decisions" != "no pending decisions" ]; then
  printf 'Decisions on beads not yet applied:\n%s\n' "$decisions"
fi
exit 0
