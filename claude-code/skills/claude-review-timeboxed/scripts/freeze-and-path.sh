#!/bin/bash
# Freeze a revision in a detached worktree and print the review output path.
#
# Usage: freeze-and-path.sh [<ref>] [<description>]
#   <ref>          revision to review (default: HEAD)
#   <description>  short kebab-case label for the file name (default: derived from the branch name)
#
# Prints three lines: REVISION=<12-char sha>, WORKTREE=<path>, REVIEW_PATH=<path>.
# The review path is <main repo root>/.claude/timeboxed-reviews/<date -I>-<description>-<sha>.md; the main
# repo root is the parent of `git rev-parse --git-common-dir`, so a git worktree resolves to its primary checkout.
set -euo pipefail

ref="${1:-HEAD}"
revision="$(git rev-parse --short=12 "$ref")"
description="${2:-}"
if [ -z "$description" ]; then
    description="$(git rev-parse --abbrev-ref "$ref" 2>/dev/null | tr '/' '-' || true)"
    if [ -z "$description" ] || [ "$description" = "HEAD" ]; then
        description="review"
    fi
fi
description="$(printf '%s' "$description" | tr -c 'A-Za-z0-9._-' '-' | sed 's/-\{2,\}/-/g; s/^-//; s/-$//')"

common_dir="$(git rev-parse --git-common-dir)"
main_root="$(cd "$(dirname "$(cd "$common_dir" && pwd)")" && pwd)"
review_dir="$main_root/.claude/timeboxed-reviews"
review_path="$review_dir/$(date -I)-$description-$revision.md"

tmp_base="${TMPDIR:-/tmp/claude}"
worktree="$tmp_base/review-$revision"

# DRY_RUN=1 prints the paths without creating the directory or the worktree.
if [ "${DRY_RUN:-0}" != "1" ]; then
    mkdir -p "$review_dir"
    if [ ! -d "$worktree" ]; then
        git worktree add --detach "$worktree" "$revision" >/dev/null
    fi
fi

echo "REVISION=$revision"
echo "WORKTREE=$worktree"
echo "REVIEW_PATH=$review_path"
