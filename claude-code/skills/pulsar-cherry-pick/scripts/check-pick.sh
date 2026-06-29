#!/usr/bin/env bash
#
# check-pick.sh — post-resolution sanity scan for a Pulsar cherry-pick.
#
# Scans the files a commit touched for the three things that silently break a
# backport from master onto an slf4j/Maven release branch:
#   1. leftover conflict markers
#   2. leftover slog (structured logger) syntax that won't compile on slf4j branches
#   3. added unguarded *argument-bearing* slf4j debug/trace (slog guards these
#      automatically; slf4j does not). Constant-message calls build nothing and are
#      reported as informational only — they need no guard.
#
# Run it after resolving conflicts and before `cherry-pick --continue`, or right
# after the pick commits. The file list comes from the source commit; the
# "added debug" diff compares the resolution against the branch tip.
#
# Usage:
#   scripts/check-pick.sh <source-sha>     # scan the files that commit touched
#   scripts/check-pick.sh                  # scan files changed by the in-progress / last pick
#
# Exit code 0 = clean, 1 = something to review. Output is advisory; a clean
# `test-compile` of the changed module is the real proof slog is gone.

set -u

sha="${1:-}"
issues=0

# A cherry-pick in progress leaves HEAD at the branch tip (changes live in the
# work tree); once it commits, the change is HEAD^..HEAD.
if git rev-parse -q --verify CHERRY_PICK_HEAD >/dev/null 2>&1; then
  diff_range=(HEAD)            # working tree vs branch tip
else
  diff_range=(HEAD^ HEAD)      # last commit
fi

# File list to scan for markers/slog.
if [ -n "$sha" ]; then
  mapfile -t files < <(git show --name-only --format='' "$sha" 2>/dev/null | grep -E '\.java$')
elif git rev-parse -q --verify CHERRY_PICK_HEAD >/dev/null 2>&1; then
  mapfile -t files < <(git diff --name-only HEAD 2>/dev/null | grep -E '\.java$')
else
  mapfile -t files < <(git diff --name-only HEAD^ HEAD 2>/dev/null | grep -E '\.java$')
fi

[ "${#files[@]}" -eq 0 ] && echo "No .java files to check."

echo "== 1. Conflict markers =="
marker_hits=0
for f in "${files[@]}"; do
  [ -f "$f" ] || continue
  if grep -nE '^(<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)' "$f" >/dev/null 2>&1; then
    echo "  MARKERS: $f"
    grep -nE '^(<<<<<<<|=======|>>>>>>>)' "$f" | head -5
    marker_hits=1
  fi
done
[ "$marker_hits" -eq 0 ] && echo "  none" || issues=1

echo "== 2. Leftover slog syntax =="
slog_hits=0
for f in "${files[@]}"; do
  [ -f "$f" ] || continue
  if grep -nE 'log\.(debug|info|warn|error|trace)\(\)|\.attr\(|\.exceptionMessage\(|\.exception\(|@CustomLog|import lombok\.CustomLog' "$f" >/dev/null 2>&1; then
    echo "  SLOG: $f"
    grep -nE 'log\.(debug|info|warn|error|trace)\(\)|\.attr\(|\.exceptionMessage\(|\.exception\(|@CustomLog' "$f" | head -10
    slog_hits=1
  fi
done
[ "$slog_hits" -eq 0 ] && echo "  none" || issues=1

echo "== 3. Added debug/trace (argument-bearing must be guarded by isDebugEnabled/isTraceEnabled) =="
added_dbg="$(git diff "${diff_range[@]}" -- '*.java' 2>/dev/null | grep -E '^\+' | grep -vE '^\+\+\+' | grep -E 'log\.(debug|trace)\(')"
# A line with a {} placeholder formats/boxes arguments on every call -> needs a guard.
# A constant-message call (no {}) builds nothing -> needs no guard, informational only.
arg_dbg="$(printf '%s\n' "$added_dbg" | grep -F '{}')"
const_dbg="$(printf '%s\n' "$added_dbg" | grep -vF '{}' | grep -E 'log\.(debug|trace)\(')"
if [ -n "$arg_dbg" ]; then
  echo "$arg_dbg" | sed 's/^/  /'
  echo "  -> review: each must be inside an isDebugEnabled()/isTraceEnabled() guard"
  issues=1
else
  echo "  none added (argument-bearing)"
fi
if [ -n "$const_dbg" ]; then
  echo "  constant-message debug/trace (no guard needed — informational):"
  echo "$const_dbg" | sed 's/^/    /'
fi

echo
if [ "$issues" -eq 0 ]; then
  echo "OK — no markers, slog, or unguarded argument-bearing debug detected. Still run: mvn -pl <module> test-compile"
else
  echo "REVIEW NEEDED — see findings above."
fi
exit "$issues"
