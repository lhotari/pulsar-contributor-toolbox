#!/bin/bash
# Freeze a revision in a detached worktree and print the review output path.
#
# Usage: freeze-and-path.sh [<ref> | <base>..<head>] [<description>] [--base <ref>]
#   <ref>          revision to review (default: HEAD); "<base>..<head>" sets both
#   <description>  short kebab-case label for the file name (default: derived from the branch name)
#   --base <ref>   base revision for the delta (default: merge-base with the default branch)
#
# Prints, in this order and before any side effect:
#   REVISION=<12-char sha>  BASE_REVISION=<12-char sha or unknown>  WORKTREE=<path>  REVIEW_PATH=<path>
# then creates the worktree and, best effort, the review directory. The review path is
# <main repo root>/.claude/timeboxed-reviews/<date -I>-<description>-<sha>.md; the main repo root is the parent
# of `git rev-parse --git-common-dir`, so a git worktree resolves to its primary checkout. A sandbox may deny
# creating that directory; the Write tool that writes the review creates it, so a denial here is only a warning.
# DRY_RUN=1 prints the four lines and exits.
set -euo pipefail

target="HEAD"
description=""
base=""
positional=()
while [ $# -gt 0 ]; do
    case "$1" in
        --base) base="$2"; shift 2 ;;
        *) positional+=("$1"); shift ;;
    esac
done
[ "${#positional[@]}" -ge 1 ] && target="${positional[0]}"
[ "${#positional[@]}" -ge 2 ] && description="${positional[1]}"

case "$target" in
    *..*) base="${base:-${target%%..*}}"; target="${target##*..}" ;;
esac

revision="$(git rev-parse --short=12 "$target")"

if [ -z "$base" ]; then
    default_branch="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)"
    for candidate in "$default_branch" master main; do
        [ -n "$candidate" ] || continue
        if git rev-parse --verify --quiet "$candidate" >/dev/null; then
            base="$(git merge-base "$candidate" "$revision" 2>/dev/null || true)"
            [ -n "$base" ] && break
        fi
    done
fi
base_revision="unknown"
[ -n "$base" ] && base_revision="$(git rev-parse --short=12 "$base")"

if [ -z "$description" ]; then
    description="$(git rev-parse --abbrev-ref "$target" 2>/dev/null | tr '/' '-' || true)"
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
if [ -d "$worktree" ] && [ "$(git -C "$worktree" rev-parse --short=12 HEAD 2>/dev/null || true)" != "$revision" ]; then
    worktree="$tmp_base/review-$revision-$$"
fi

echo "REVISION=$revision"
echo "BASE_REVISION=$base_revision"
echo "WORKTREE=$worktree"
echo "REVIEW_PATH=$review_path"

[ "${DRY_RUN:-0}" = "1" ] && exit 0

if [ ! -d "$worktree" ]; then
    git worktree add --detach "$worktree" "$revision" >/dev/null
fi
mkdir -p "$review_dir" 2>/dev/null || echo "warning: could not create $review_dir here; the Write tool will create it" >&2
