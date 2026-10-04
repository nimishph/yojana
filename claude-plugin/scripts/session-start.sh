#!/usr/bin/env sh
# SessionStart: point the session at this installation's yojana.config.json, then, in a repository
# that keeps yojana plans, tell Claude so, and what waits on a person (open changes, decisions on
# beads). Reads the log only, never bd or anvesa, so it is fast.
#
# $1 is the plugin's data folder (${CLAUDE_PLUGIN_DATA}), kept across plugin updates; the config
# lives there. YOJANA_CONFIG, and YOJANA_HOME from the file's "home", go to CLAUDE_ENV_FILE, which
# Claude Code loads into the environment of the session's Bash commands. A YOJANA_CONFIG or
# YOJANA_HOME already set (e.g. in settings.json) is kept.
here="$(dirname "$0")"
export_var() {
  export "$1=$2"
  [ -n "${CLAUDE_ENV_FILE:-}" ] || return 0
  printf "export %s='%s'\n" "$1" "$(printf '%s' "$2" | sed "s/'/'\\\\''/g")" >>"$CLAUDE_ENV_FILE"
}
if [ -n "${1:-}" ] && [ -z "${YOJANA_CONFIG:-}" ]; then
  export_var YOJANA_CONFIG "$1/yojana.config.json"
fi
if [ -z "${YOJANA_HOME:-}" ] && [ -n "${YOJANA_CONFIG:-}" ] && [ -f "$YOJANA_CONFIG" ]; then
  home="$(bun "$here/config-env.ts" "$YOJANA_CONFIG" 2>/dev/null)"
  [ -n "$home" ] && export_var YOJANA_HOME "$home"
fi

root="${CLAUDE_PROJECT_DIR:-$PWD}"
[ -f "$root/.yojana/log.jsonl" ] || exit 0
yojana="$here/../bin/yojana"

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
