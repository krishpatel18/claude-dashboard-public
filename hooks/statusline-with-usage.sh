#!/bin/sh
# Claude dashboard: status-line wrapper. Claude Code sends the status line
# its session details (including plan usage, `rate_limits`) on every redraw.
# This saves the usage part for the dashboard, then hands the input unchanged
# to your own status line, given as this script's arguments. With no
# arguments it prints nothing, so Claude Code shows no status line.
#
#   "statusLine": { "type": "command",
#     "command": "$HOME/.claude/statusline-with-usage ~/.claude/my-statusline.sh" }
#
# Needs jq (`which jq` shows whether you have it; otherwise `brew install jq`).
input=$(cat)
dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/dashboard"
umask 077
mkdir -p "$dir" 2>/dev/null
tmp="$dir/.statusline.$$"
if printf '%s' "$input" | jq -c '{rate_limits, at: now}' > "$tmp" 2>/dev/null; then
  mv -f "$tmp" "$dir/usage.json"
else
  rm -f "$tmp"
fi
[ $# -gt 0 ] || exit 0
printf '%s' "$input" | exec sh -c "$*"
