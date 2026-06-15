#!/usr/bin/env sh
# Launch the claude-code-multi tmuxp session, then label each pane.
#
# tmuxp has no native pane-title/-name option, and the obvious workarounds all race:
#   - `select-pane -T` writes pane_title, which the shell prompt re-writes on every
#     redraw, so the label gets clobbered.
#   - targeting panes by index (.0/.1) is non-deterministic under `pane-base-index 1`.
# The race-free approach is to address panes by their discovered pane_id and write a
# custom user option (@label) that nothing else touches, after the session is built
# (`tmuxp load -d`) so the panes already exist and no send-keys timing is involved.
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

# Label panes by pane_id (immune to pane-base-index) using a custom user option
# (@label) that the shell prompt never overwrites (unlike pane_title).
idx=0
for win in $(tmux list-windows -t "$session" -F '#{window_id}'); do
    idx=$((idx + 1))
    tmux set-option -w -t "$win" pane-border-status top
    tmux set-option -w -t "$win" pane-border-format '#{?#{!=:#{@label},},#{@label},#{pane_index}}'
    # even-vertical stacks panes top->bottom in list order: first = claude, second = shell.
    tmux list-panes -t "$win" -F '#{pane_id}' | {
        read -r top
        read -r bottom
        [ -n "${top:-}" ] && tmux set-option -p -t "$top" @label "claude-$idx"
        [ -n "${bottom:-}" ] && tmux set-option -p -t "$bottom" @label "shell-$idx"
    }
done

# Attach (or switch, if we're already inside tmux).
if [ -n "${TMUX:-}" ]; then
    tmux switch-client -t "$session"
else
    tmux attach-session -t "$session"
fi
