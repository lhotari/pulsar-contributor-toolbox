#!/usr/bin/env sh
# Launch the claude-code-multi tmuxp session, then title each pane "claude-N"/"shell-N".
#
# tmuxp has no native pane-title option, so we set pane_title with `select-pane -T`
# after the session is built (`tmuxp load -d`), addressing panes by their discovered
# pane_id -- targeting by index (.0/.1) is non-deterministic under `pane-base-index 1`.
# pane_title defaults to the hostname, and nothing in a Starship shell reclaims it, so the
# title sticks (the claude pane may set its own title, which is fine). The user's
# ~/.tmux.conf already renders #{pane_title} in the status bar and `set-titles-string "#T"`
# in the terminal title, so setting pane_title is all we need -- no format overrides.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
CONFIG="$SCRIPT_DIR/claude-code-multi.yaml"

# Pin the panes' working directory to where the launcher was invoked from.
: "${AGENT_START_DIR:=$PWD}"
export AGENT_START_DIR

# Read the session name straight from the config so the two never drift.
session=$(awk -F':' '/^session_name:/ { gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2; exit }' "$CONFIG")
: "${session:?could not read session_name from $CONFIG}"

# Build the session detached so every pane exists before we label it.
tmuxp load -d "$CONFIG"

# Title each pane by pane_id (immune to pane-base-index). The status bar and the outer
# terminal title both render #{pane_title} via the user's global ~/.tmux.conf, so setting
# pane_title is all that is needed -- no per-window status/title format overrides.
idx=0
for win in $(tmux list-windows -t "$session" -F '#{window_id}'); do
    idx=$((idx + 1))
    tmux set-option -w -t "$win" pane-border-status top
    tmux set-option -w -t "$win" pane-border-format ' #{pane_title} '
    # even-vertical stacks panes top->bottom in list order: first = claude, second = shell.
    tmux list-panes -t "$win" -F '#{pane_id}' | {
        read -r top
        read -r bottom
        [ -n "${top:-}" ] && tmux select-pane -t "$top" -T "claude-$idx"
        [ -n "${bottom:-}" ] && tmux select-pane -t "$bottom" -T "shell-$idx"
    }
done

# Attach (or switch, if we're already inside tmux).
if [ -n "${TMUX:-}" ]; then
    tmux switch-client -t "$session"
else
    tmux attach-session -t "$session"
fi
