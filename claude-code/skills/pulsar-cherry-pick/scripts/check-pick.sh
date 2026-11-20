#!/usr/bin/env bash
#
# check-pick.sh — post-resolution sanity scan for a Pulsar cherry-pick.
#
# Scans the files a commit touched for the four things that silently break a
# backport from master onto an slf4j/Maven release branch:
#   1. leftover conflict markers
#   2. leftover slog (structured logger) syntax that won't compile on slf4j branches
#   3. added unguarded *argument-bearing* slf4j debug/trace (slog guards these
#      automatically; slf4j does not). A call whose enclosing block opener checks
#      isDebugEnabled()/isTraceEnabled() counts as guarded. Guarded and constant-message
#      calls are reported as informational only.
#   4. Gradle build files left in the tree of a Maven branch (the change belongs in a pom.xml)
#
# Run it after resolving conflicts and before `cherry-pick --continue`, or right
# after the pick commits. The file list comes from the source commit; the
# "added debug" diff compares the resolution against the branch tip.
#
# Usage:
#   scripts/check-pick.sh <source-sha>          # scan the files that commit touched
#   scripts/check-pick.sh <source-sha> <base>   # ... comparing <base>..HEAD (a pick followed by its fixups)
#   scripts/check-pick.sh                       # scan files changed by the in-progress / last pick
#
# Slog and debug findings look only at lines the pick adds: code already on the branch
# (e.g. BookKeeper's FutureUtils.exception(...)) is not the pick's to fix.
#
# Exit code 0 = clean, 1 = something to review. Output is advisory; a clean
# `test-compile` of the changed module is the real proof slog is gone.

set -u

sha="${1:-}"
base="${2:-}"
issues=0

# A cherry-pick in progress leaves HEAD at the branch tip (changes live in the
# work tree); once it commits, the change is HEAD^..HEAD (or <base>..HEAD when given).
if git rev-parse -q --verify CHERRY_PICK_HEAD >/dev/null 2>&1; then
  diff_range=(HEAD)            # working tree vs branch tip
elif [ -n "$base" ]; then
  diff_range=("$base" HEAD)
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

echo "== 2. Leftover slog syntax (added lines) =="
# slog chains: log.info().attr(...).log(...), a continuation line starting with .attr(/.exception(,
# @CustomLog. FutureUtils.exception(...) and the like are not slog and are not matched.
slog_re='log[.](debug|info|warn|error|trace)[(][)]|(^[[:space:]]*|[)])[.](attr|exceptionMessage|exception)[(]|@CustomLog|import lombok[.]CustomLog'
slog_hits="$(git diff -U0 "${diff_range[@]}" -- "${files[@]}" 2>/dev/null | awk -v re="$slog_re" '
  /^\+\+\+ / { f = substr($0, 7); next }
  /^@@/ { split($3, a, ","); n = substr(a[1], 2) + 0; next }
  /^\+/ { code = substr($0, 2); if (code ~ re) printf "%s:%d: %s\n", f, n, code; n++; next }
' | head -20)"
if [ "${#files[@]}" -gt 0 ] && [ -n "$slog_hits" ]; then
  printf '%s\n' "$slog_hits" | sed 's/^/  SLOG: /'
  issues=1
else
  echo "  none"
fi

echo "== 3. Added debug/trace (argument-bearing must be guarded by isDebugEnabled/isTraceEnabled) =="
# Added debug/trace lines with their position in the new file: "<file>\t<line>\t<text>".
added_dbg="$(git diff -U0 "${diff_range[@]}" -- '*.java' 2>/dev/null | awk '
  /^\+\+\+ / { f = substr($0, 7); next }
  /^@@/ { split($3, a, ","); n = substr(a[1], 2) + 0; next }
  /^\+/ { if ($0 ~ /log\.(debug|trace)\(/) printf "%s\t%d\t%s\n", f, n, $0; n++; next }
')"
# The content the line numbers refer to: the work tree during a cherry-pick, HEAD once it committed.
file_content() {
  if [ "${#diff_range[@]}" -eq 1 ]; then cat "$1" 2>/dev/null; else git show "HEAD:$1" 2>/dev/null; fi
}
# A call is guarded when the nearest less-indented line above it (its enclosing block opener)
# checks isDebugEnabled()/isTraceEnabled().
is_guarded() {
  file_content "$1" | awk -v target="$2" '
    function indent(s) { match(s, /^[ \t]*/); return RLENGTH }
    { lines[NR] = $0 }
    END {
      ind = indent(lines[target])
      for (i = target - 1; i > 0; i--) {
        if (lines[i] ~ /^[ \t]*$/) continue
        if (indent(lines[i]) < ind) exit (lines[i] ~ /is(Debug|Trace)Enabled\(/) ? 0 : 1
      }
      exit 1
    }'
}
# A line with a {} placeholder formats/boxes arguments on every call -> needs a guard.
# A constant-message call (no {}) builds nothing -> needs no guard, informational only.
arg_dbg=""; guarded_dbg=""; const_dbg=""
while IFS=$'\t' read -r f n text; do
  [ -n "$f" ] || continue
  if [[ "$text" != *"{}"* ]]; then const_dbg+="$text"$'\n'
  elif is_guarded "$f" "$n"; then guarded_dbg+="$text"$'\n'
  else arg_dbg+="$f:$n: $text"$'\n'
  fi
done <<< "$added_dbg"
if [ -n "$arg_dbg" ]; then
  printf '%s' "$arg_dbg" | sed 's/^/  /'
  echo "  -> each must be inside an isDebugEnabled()/isTraceEnabled() guard"
  issues=1
else
  echo "  none unguarded (argument-bearing)"
fi
if [ -n "$guarded_dbg" ]; then
  echo "  guarded argument-bearing debug/trace (informational):"
  printf '%s' "$guarded_dbg" | sed 's/^/    /'
fi
if [ -n "$const_dbg" ]; then
  echo "  constant-message debug/trace (no guard needed — informational):"
  printf '%s' "$const_dbg" | sed 's/^/    /'
fi

echo "== 4. Gradle files on a Maven branch =="
# master builds with Gradle, the release branches with Maven. A Gradle file that applied (a new
# build.gradle.kts, a libs.versions.toml hunk) does nothing on a Maven branch: the change belongs in a pom.xml.
gradle_hits=0
if [ -f pom.xml ] && [ ! -f settings.gradle.kts ] && [ ! -f settings.gradle ]; then
  if [ -n "$sha" ]; then
    mapfile -t all_files < <(git show --name-only --format='' "$sha" 2>/dev/null)
  elif git rev-parse -q --verify CHERRY_PICK_HEAD >/dev/null 2>&1; then
    mapfile -t all_files < <(git diff --name-only HEAD 2>/dev/null)
  else
    mapfile -t all_files < <(git diff --name-only HEAD^ HEAD 2>/dev/null)
  fi
  for f in "${all_files[@]}"; do
    case "$f" in
      *.gradle|*.gradle.kts|gradle/libs.versions.toml|gradle/*.versions.toml)
        if [ -f "$f" ]; then echo "  GRADLE: $f (move the change to the Maven pom.xml, then git rm it)"; gradle_hits=1; fi ;;
    esac
  done
fi
[ "$gradle_hits" -eq 0 ] && echo "  none" || issues=1

echo
if [ "$issues" -eq 0 ]; then
  echo "OK — no markers, slog, or unguarded argument-bearing debug detected. Still run: mvn -pl <module> test-compile"
else
  echo "REVIEW NEEDED — see findings above."
fi
exit "$issues"
