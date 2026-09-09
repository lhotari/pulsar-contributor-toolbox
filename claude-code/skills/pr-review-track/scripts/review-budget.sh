#!/usr/bin/env bash
#
# review-budget.sh — turn the live subscription usage into a review plan.
#
# Reads both quotas the review pipeline can spend and answers, for each, the
# only question that actually matters:
#
#   pace = (share of the limit already used) / (share of the window elapsed)
#
# pace 1.0 is dead on schedule. 1.5 means the allowance runs out at two thirds
# of the window. Every window a provider reports is paced; the worst one decides,
# floored by the raw percentage, because a window that is 94% gone is constrained
# however evenly it was spent.
#
#   Claude side (wraps claude-usage.sh --json) -> a `pr-review` tier, plus a
#                                                 separate gate on Fable
#   Codex side  (wraps codex-usage.sh  --json) -> a model and an effort ceiling
#                                                 for thoughtful and simple work
#
# Usage:
#   ./review-budget.sh                # both halves, compact report
#   ./review-budget.sh --json         # both halves, structured
#   ./review-budget.sh --codex-only   # Codex host: never touches Claude creds
#   ./review-budget.sh --claude-only  # skip the Codex probe
#   ./review-budget.sh --no-cache     # bypass both wrapped scripts' caches
#
# Exit codes, so a shell caller can branch without parsing:
#   0  both quotas comfortable
#   3  the Claude tier is `codex` — hand what you can to Codex
#   4  the Codex budget is `critical` — trim effort and model everywhere
#      (4 wins when both are true: there is no cheap side left to move work to)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_SH="${HERE}/claude-usage.sh"
CODEX_SH="${HERE}/codex-usage.sh"

OUTPUT_JSON=0
WANT_CLAUDE=1
WANT_CODEX=1
PASSTHRU=()

for arg in "$@"; do
  case "$arg" in
    --json)        OUTPUT_JSON=1 ;;
    --codex-only)  WANT_CLAUDE=0 ;;
    --claude-only) WANT_CODEX=0 ;;
    --no-cache)    PASSTHRU+=(--no-cache) ;;
    -h|--help)     sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }

NOW=$(date +%s)

# Shared jq preamble: parse a timestamp, pace a window, and floor the elapsed
# share so a window that just opened cannot divide pace into nonsense.
read -r -d '' JQ_PACE <<'JQ' || true
  def epoch:
    if . == null or . == "" then null
    elif type == "number" then (if . > 100000000000 then . / 1000 else . end | floor)
    else (sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | fromdateiso8601)
    end;

  # {percent, resets_at} + window seconds + the percentage below which the
  # reading is too young to trust -> a paced window.
  def paced($label; $span; $floor):
    (.percent // null) as $p
    | ((.resets_at // null) | epoch) as $r
    | if $p == null or $r == null or $span == null or $span <= 0 then
        { window: $label, percent: $p, elapsed: null, pace: null, counts: false, resets: null }
      else
        ((($span - ($r - $now)) / $span) | if . < 0.02 then 0.02 elif . > 1 then 1 else . end) as $e
        | { window: $label,
            percent: $p,
            elapsed: ($e * 100 | round),
            pace: (($p / 100 / $e) * 100 | round / 100),
            counts: ($p >= $floor),
            resets: ($r | todate) }
      end;

  # The worst pace among windows old enough to count.
  def worst: map(select(.counts and .pace != null) | .pace) | max;
JQ

# --------------------------------------------------------------------------
# Claude: a `pr-review` tier plus the Fable gate.
# --------------------------------------------------------------------------
claude_plan() {
  local raw
  raw=$("$CLAUDE_SH" --json ${PASSTHRU[@]+"${PASSTHRU[@]}"} 2>/dev/null) || {
    printf '%s' '{"available":false,"why":"could not read the Claude usage endpoint — fall back to pr-review'"'"'s budget.mjs"}'
    return 0
  }

  printf '%s' "$raw" | jq -c --argjson now "$NOW" "$JQ_PACE"'
    . as $root
    | ($root.limits // []) as $L
    | (($L | map(select(.kind == "session")) | first)
        // { percent: $root.five_hour.utilization, resets_at: $root.five_hour.resets_at })
        as $sRaw
    | (($L | map(select(.kind == "weekly_all")) | first)
        // { percent: $root.seven_day.utilization, resets_at: $root.seven_day.resets_at })
        as $wRaw
    | (($L | map(select(.kind == "weekly_scoped"
          and ((.scope.model.display_name // "") | ascii_downcase) == "fable")) | first).percent // null)
        as $fable

    | ($sRaw | paced("session 5h"; 5 * 3600; 25)) as $session
    | ($wRaw | paced("weekly 7d"; 7 * 86400; 20)) as $weekly
    | ([$session, $weekly] | worst) as $worst
    | ($weekly.percent // 0) as $wp
    | (($L | map(select(.severity == "critical")) | length) > 0) as $critical

    | (if $wp >= 95 or $critical or ($worst != null and $worst >= 2.0) then "codex"
       elif $wp >= 85 or ($worst != null and $worst >= 1.5) then "lean"
       elif $wp >= 60 or ($worst != null and $worst >= 1.0) then "standard"
       else "full" end) as $tier

    | (if $tier == "codex" or $tier == "lean" then "avoid"
       elif ($fable != null and $fable >= 70) then "avoid"
       elif $tier == "standard" or ($fable != null and $fable >= 50) then "sparing"
       else "ok" end) as $fableUse

    | (" weekly at \($wp)%\(if $worst then ", pace \($worst)×" else "" end)") as $tail
    | (if $critical then "weekly limit reported critical at \($wp)% — hand everything you can to Codex"
       elif $tier == "codex" then "\($tail | ltrimstr(" ")) — the allowance will not carry a Claude-led batch"
       elif $tier == "lean" then "\($tail | ltrimstr(" ")) — ahead of schedule, trim Claude to adjudication"
       elif $tier == "standard" then "\($tail | ltrimstr(" ")) — roughly on schedule"
       else "\($tail | ltrimstr(" ")) — comfortably under" end) as $why

    | { available: true, tier: $tier, why: $why, worstPace: $worst, critical: $critical,
        fable: $fableUse, fableWeeklyPercent: $fable,
        windows: [$session, $weekly] }
  '
}

# --------------------------------------------------------------------------
# Codex: a model and an effort ceiling. Every window the account exposes is
# paced generically — `primary`/`secondary` are labels that move around, and
# `credits` is not a window at all, so select on windowDurationMins.
# --------------------------------------------------------------------------
codex_plan() {
  local raw
  raw=$("$CODEX_SH" --json ${PASSTHRU[@]+"${PASSTHRU[@]}"} 2>/dev/null) || {
    printf '%s' '{"available":false,"why":"could not read Codex rate limits — codex CLI missing, signed out, or on an API key"}'
    return 0
  }

  printf '%s' "$raw" | jq -c --argjson now "$NOW" "$JQ_PACE"'
    def winlabel:
      if   . == null  then "window"
      elif . <= 60    then "\(.)m"
      elif . < 1440   then "\(. / 60 | floor)h"
      elif . == 1440  then "daily"
      elif . == 10080 then "weekly"
      elif . >= 40000 and . <= 46000 then "monthly"
      else "\(. / 1440 | floor)d" end;

    . as $root
    | ([ $root | to_entries[]
         | select(.value | type == "object")
         | .value
         | { mins: (.windowDurationMins // .window_duration_mins // null),
             percent: (.usedPercent // .used_percent // null),
             resets_at: (.resetsAt // .resets_at // null) }
         | select(.mins != null)
       ]) as $raws
    | ([ $raws[] | paced((.mins | winlabel); (.mins * 60); 20) ]) as $windows

    | ($windows | worst) as $worst
    | ([ $windows[].percent | select(. != null) ] | max // 0) as $peak
    | (($root.spendControlReached // false)
        or (($root.rateLimitReachedType // null) != null)) as $blocked

    | (if $blocked or $peak >= 90 or ($worst != null and $worst >= 2.0) then "critical"
       elif $peak >= 75 or ($worst != null and $worst >= 1.5) then "tight"
       elif $peak >= 55 or ($worst != null and $worst >= 1.0) then "normal"
       else "rich" end) as $budget

    # At `critical` the expensive model itself goes, not just its effort: a
    # cheap model thinking hard beats an expensive one that cannot finish.
    | (if $budget == "critical" then { model: "gpt-5.6-sol", effort: "high" }
       elif $budget == "tight"  then { model: "gpt-6-astra", effort: "medium" }
       elif $budget == "normal" then { model: "gpt-6-astra", effort: "high" }
       else { model: "gpt-6-astra", effort: "xhigh" } end) as $thoughtful

    | (if $budget == "critical" then { model: "gpt-5.6-sol", effort: "minimal" }
       elif $budget == "tight"  then { model: "gpt-5.6-sol", effort: "minimal" }
       else { model: "gpt-5.6-sol", effort: "low" } end) as $simple

    | (if $blocked then "rate limit or spend control already reached — Codex cannot carry the batch either"
       elif $windows | length == 0 then "no rate limit windows reported\(if ($root.planType // null) then " for a \($root.planType) plan" else "" end)"
       else "\(($windows | map(select(.percent != null)) | max_by(.percent) | "\(.window) at \(.percent)%"))\(if $worst then ", pace \($worst)×" else "" end) — \(
              if $budget == "critical" then "drop to the cheap model everywhere"
              elif $budget == "tight" then "keep gpt-6-astra but cap its effort"
              elif $budget == "normal" then "roughly on schedule"
              else "comfortably under" end)"
       end) as $why

    | { available: true, budget: $budget, why: $why, worstPace: $worst,
        peakPercent: $peak, blocked: $blocked, plan: ($root.planType // null),
        thoughtful: $thoughtful, simple: $simple, windows: $windows }
  '
}

CLAUDE_JSON='{"available":false,"why":"not read (--codex-only)"}'
CODEX_JSON='{"available":false,"why":"not read (--claude-only)"}'
(( WANT_CLAUDE )) && CLAUDE_JSON=$(claude_plan)
(( WANT_CODEX ))  && CODEX_JSON=$(codex_plan)

PLAN=$(jq -nc --argjson claude "$CLAUDE_JSON" --argjson codex "$CODEX_JSON" '{claude: $claude, codex: $codex}')

if (( OUTPUT_JSON )); then
  printf '%s\n' "$PLAN" | jq .
else
  printf '%s' "$PLAN" | jq -r '
    def wins: [ .[] | "\(.window) \(if .percent == null then "n/a" else "\(.percent)%" end)\(
        if .pace == null then "" else "/\(.elapsed)% elapsed, pace \(.pace)×\(if .counts then "" else " (too early to count)" end)" end)" ]
      | join("  ·  ");

    (if .claude.available then
       "claude tier:  \(.claude.tier)\n" +
       "  why:        \(.claude.why)\n" +
       "  windows:    \(.claude.windows | wins)\n" +
       "  fable:      \(.claude.fable)\(if .claude.fableWeeklyPercent then " (Fable weekly at \(.claude.fableWeeklyPercent)%)" else "" end)"
     else "claude tier:  unavailable — \(.claude.why)" end),
    (if .codex.available then
       "codex budget: \(.codex.budget)\n" +
       "  why:        \(.codex.why)\n" +
       "  windows:    \(.codex.windows | wins)\n" +
       "  thoughtful: \(.codex.thoughtful.model) --effort \(.codex.thoughtful.effort)\n" +
       "  simple:     \(.codex.simple.model) --effort \(.codex.simple.effort)"
     else "codex budget: unavailable — \(.codex.why)" end)
  '
fi

CLAUDE_TIER=$(printf '%s' "$PLAN" | jq -r '.claude.tier // ""')
CODEX_BUDGET=$(printf '%s' "$PLAN" | jq -r '.codex.budget // ""')

[[ "$CODEX_BUDGET" == "critical" ]] && exit 4
[[ "$CLAUDE_TIER" == "codex" ]] && exit 3
exit 0
