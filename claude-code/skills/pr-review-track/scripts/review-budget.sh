#!/usr/bin/env bash
#
# review-budget.sh — turn the live Claude subscription usage into a review tier
# and a model plan.
#
# Wraps claude-usage.sh --json (the real, server-reported utilization) and
# answers the only question the review pipeline actually has: at the rate this
# window is being consumed, will the allowance run out before the window resets?
#
#   pace = (share of the limit already used) / (share of the window elapsed)
#
# pace 1.0 is dead on schedule. 1.5 means the allowance runs out at two thirds
# of the window. The tier falls out of the worst pace across the 5-hour session
# window and the 7-day window, floored by the raw weekly percentage — because a
# week that is 94% gone is constrained no matter how evenly it was spent.
#
# ONLY MEANINGFUL ON A CLAUDE CODE HOST. A Codex host has no Claude allowance to
# measure and must not run this at all.
#
# Usage:
#   ./review-budget.sh            # compact report (5 lines)
#   ./review-budget.sh --json     # machine-readable
#   ./review-budget.sh --no-cache # bypass claude-usage.sh's 2-minute cache
#
# Exit code is 0 normally, 3 when the tier is `codex` — so a shell caller can
# branch without parsing anything.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USAGE_SH="${HERE}/claude-usage.sh"

OUTPUT_JSON=0
PASSTHRU=()

for arg in "$@"; do
  case "$arg" in
    --json)     OUTPUT_JSON=1 ;;
    --no-cache) PASSTHRU+=(--no-cache) ;;
    -h|--help)  sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }
[[ -x "$USAGE_SH" ]] || { echo "missing or non-executable: $USAGE_SH" >&2; exit 1; }

RAW=$("$USAGE_SH" --json ${PASSTHRU[@]+"${PASSTHRU[@]}"}) \
  || { echo "could not read Claude usage — fall back to pr-review's budget.mjs" >&2; exit 1; }

PLAN=$(printf '%s' "$RAW" | jq -c --argjson now "$(date +%s)" '
  def epoch:
    if . == null or . == "" then null
    elif type == "number" then (if . > 100000000000 then . / 1000 else . end | floor)
    else (sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | fromdateiso8601)
    end;

  # A window barely started divides by almost nothing, so pace explodes on noise.
  # Floor the elapsed share, and below `$floor` percent used report the pace but
  # mark it untrustworthy rather than letting it pick the tier.
  def window($span; $floor):
    (.percent // null) as $p
    | ((.resets_at // null) | epoch) as $r
    | if $p == null or $r == null then
        { percent: $p, elapsed: null, pace: null, counts: false, resets: null }
      else
        ((($span - ($r - $now)) / $span) | if . < 0.02 then 0.02 elif . > 1 then 1 else . end) as $e
        | { percent: $p,
            elapsed: ($e * 100 | round),
            pace: (($p / 100 / $e) * 100 | round / 100),
            counts: ($p >= $floor),
            resets: ($r | todate) }
      end;

  . as $root
  | ($root.limits // []) as $L
  | (($L | map(select(.kind == "session")) | first)
      // { percent: $root.five_hour.utilization, resets_at: $root.five_hour.resets_at })
      as $sRaw
  | (($L | map(select(.kind == "weekly_all")) | first)
      // { percent: $root.seven_day.utilization, resets_at: $root.seven_day.resets_at })
      as $wRaw
  | ($L | map(select(.kind == "weekly_scoped"
        and ((.scope.model.display_name // "") | ascii_downcase) == "fable")) | first)
      as $fRaw

  | ($sRaw | window(5 * 3600; 25)) as $session
  | ($wRaw | window(7 * 86400; 20)) as $weekly
  | (($fRaw.percent) // null) as $fable

  | ([$session, $weekly] | map(select(.counts and .pace != null) | .pace) | max) as $worst
  | ($weekly.percent // 0) as $wp
  | (($L | map(select(.severity == "critical")) | length) > 0) as $critical

  | (if $wp >= 95 or $critical or ($worst != null and $worst >= 2.0) then "codex"
     elif $wp >= 85 or ($worst != null and $worst >= 1.5) then "lean"
     elif $wp >= 60 or ($worst != null and $worst >= 1.0) then "standard"
     else "full" end) as $tier

  | (if $tier == "codex" then "avoid"
     elif $tier == "lean" then "avoid"
     elif ($fable != null and $fable >= 70) then "avoid"
     elif $tier == "standard" or ($fable != null and $fable >= 50) then "sparing"
     else "ok" end) as $fableUse

  | (if $tier == "codex" and $critical then
       "weekly limit at \($wp)% and reported critical — hand everything you can to Codex"
     elif $tier == "codex" then
       "weekly at \($wp)%\(if $worst then ", pace \($worst)×" else "" end) — the allowance will not carry a Claude-led batch"
     elif $tier == "lean" then
       "weekly at \($wp)%\(if $worst then ", pace \($worst)×" else "" end) — ahead of schedule, trim Claude to adjudication"
     elif $tier == "standard" then
       "weekly at \($wp)%\(if $worst then ", pace \($worst)×" else "" end) — roughly on schedule"
     else
       "weekly at \($wp)%\(if $worst then ", pace \($worst)×" else "" end) — comfortably under"
     end) as $why

  | { tier: $tier, why: $why, worstPace: $worst, critical: $critical,
      fableWeeklyPercent: $fable, fable: $fableUse,
      session: $session, weekly: $weekly }
')

if (( OUTPUT_JSON )); then
  printf '%s\n' "$PLAN" | jq .
else
  printf '%s' "$PLAN" | jq -r '
    def w: if .percent == null then "not reported by the endpoint"
           elif .pace == null then "\(.percent)% used (no reset time, so no pace)"
           else "\(.percent)% used, \(.elapsed)% of the window elapsed, pace \(.pace)×\(if .counts then "" else " — too early to count" end)"
           end;
    "tier:    \(.tier)",
    "why:     \(.why)",
    "session: \(.session | w)",
    "weekly:  \(.weekly | w)",
    "fable:   \(.fable)\(if .fableWeeklyPercent then " (Fable weekly at \(.fableWeeklyPercent)%)" else "" end)"
  '
fi

[[ "$(printf '%s' "$PLAN" | jq -r .tier)" == "codex" ]] && exit 3
exit 0
