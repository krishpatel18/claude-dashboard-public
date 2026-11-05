#!/bin/sh
# Claude dashboard: Claude Code's PermissionRequest hook. Sends the request
# to the dashboard and waits for your answer there. Prints nothing (so the
# terminal prompt decides) if the dashboard isn't running, no dashboard page
# is open, or the terminal is answered first, which ends this script.
dir="${CLAUDE_DASHBOARD_DIR:-$HOME/.config/claude-dashboard}"
url=$(cat "$dir/url" 2>/dev/null) || exit 0
[ -r "$dir/curl-config" ] || exit 0
# The key comes from a private curl config file, never the command line.
curl -sS --fail --max-time 590 -K "$dir/curl-config" -X POST \
  -H 'content-type: application/json' \
  --data-binary @- "$url/api/approvals" 2>/dev/null
exit 0
