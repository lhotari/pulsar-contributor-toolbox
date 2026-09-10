#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
SKILLS_DIR="$SCRIPT_DIR/skills"
link_skill() {
    local source="$1"
    local target="$2"
    if [ -L "$target" ]; then
        echo "Removing existing link: $target"
        rm "$target"
    fi
    if [ ! -e "$target" ]; then
        ln -s "$source" "$target"
        echo "Linked skill: $target"
    else
        echo "Skipping skill: $target (existing file or directory found)"
    fi
}

for target_dir in "$HOME/.claude/skills" "$HOME/.agents/skills"; do
    mkdir -p "$target_dir"

    # Replace existing symlinks and create new ones for each skill with a SKILL.md.
    for skill_md in "$SKILLS_DIR"/*/SKILL.md; do
        [ -f "$skill_md" ] || continue
        skill="$(basename "$(dirname "$skill_md")")"
        link_skill "$SKILLS_DIR/$skill" "$target_dir/$skill"
    done

    # Expose pr-review-track under the shorter prt alias as well.
    if [ -f "$SKILLS_DIR/pr-review-track/SKILL.md" ]; then
        link_skill "$SKILLS_DIR/pr-review-track" "$target_dir/prt"
    fi
done
