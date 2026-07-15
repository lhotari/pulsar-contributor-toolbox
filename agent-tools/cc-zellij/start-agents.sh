#!/usr/bin/env sh
# Launch the claude-code-multi zellij session from claude-code-multi.kdl.
#
# Unlike the tmuxp variant, no post-build pane labelling is needed: zellij layouts
# name panes natively (name="claude-N"/"shell-N" in the .kdl). The wrapper only
# provides what a zellij layout cannot express itself (layouts don't expand
# environment variables):
#   - the panes' working directory: the session is created from inside
#     AGENT_START_DIR and panes inherit it
#   - CLAUDE_CMD: the shared agent command line, inherited by the command panes
#     from the zellij server's environment at session creation
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
LAYOUT="$SCRIPT_DIR/claude-code-multi.kdl"
SESSION="claude-code-multi"

# Pin the panes' working directory to where the launcher was invoked from.
: "${AGENT_START_DIR:=$PWD}"

# Shared command line for all agents. Each claude pane in the layout appends its
# agent-specific part.
CLAUDE_CMD="claude --settings '{\"ultracode\":true}' --effort=xhigh --remote-control"
export CLAUDE_CMD

# zellij has no tmux-style switch-client and refuses nested attaches.
if [ -n "${ZELLIJ:-}" ]; then
    echo "already inside a zellij session; detach first or switch via the session manager" >&2
    exit 1
fi

cd "$AGENT_START_DIR"

# Build the session detached if it doesn't exist yet, then attach -- mirroring the
# tmuxp `load -d` + attach flow. Creation must go through `attach --create-background`
# with the layout as the session's default layout: plain `--session` + `--layout`
# means "append the layout's tabs to an existing session" and fails when there is
# none. The existence check also covers resurrectable EXITED sessions.
if ! zellij list-sessions --short --no-formatting 2>/dev/null | grep -qx "$SESSION"; then
    zellij attach --create-background "$SESSION" options --default-layout "$LAYOUT"
fi
exec zellij attach "$SESSION"
