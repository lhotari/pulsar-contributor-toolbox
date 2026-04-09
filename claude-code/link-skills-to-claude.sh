#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
SKILLS_DIR="$SCRIPT_DIR/skills"
TARGET_DIR="$HOME/.claude/skills"

mkdir -p "$TARGET_DIR"

# Replace existing symlinks and create new ones for each skill with a SKILL.md
for skill_md in "$SKILLS_DIR"/*/SKILL.md; do
    [ -f "$skill_md" ] || continue
    skill="$(basename "$(dirname "$skill_md")")"
    if [ -L "$TARGET_DIR/$skill" ]; then
        echo "Removing existing link for skill: $skill"
        rm "$TARGET_DIR/$skill"
    fi
    if [ ! -e "$TARGET_DIR/$skill" ]; then
        ln -s "$SKILLS_DIR/$skill" "$TARGET_DIR/$skill"
        echo "Linked skill: $skill"
    else
        echo "Skipping skill: $skill (existing file or directory found)"
    fi
done
