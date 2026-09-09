#!/usr/bin/env bash
#
# codex-usage.sh — read Codex subscription rate limits via the app-server RPC.
#
# Talks JSON-RPC 2.0 (NDJSON, no "jsonrpc" field on the wire) to `codex app-server`:
#   initialize -> await response -> initialized -> account/rateLimits/read
# No LLM round-trip, so this consumes no quota.
#
# Usage:
#   ./codex-usage.sh              # human-readable
#   ./codex-usage.sh --compact    # one line, for a statusline
#   ./codex-usage.sh --json       # raw rateLimits object
#   ./codex-usage.sh --no-cache   # bypass the cache
#
# Requires: bash >= 4 (coproc), jq, codex >= 0.130 on PATH.
# Note: use `codex app-server`, NOT `codex app-server proxy` — the proxy path
#       was reported to silently consume stdin and exit 0 on 0.131.

set -euo pipefail

if (( BASH_VERSINFO[0] < 4 )); then
  echo "needs bash >= 4 (macOS ships 3.2). Try: brew install bash, then run with $(brew --prefix)/bin/bash" >&2
  exit 1
fi

CACHE_FILE="${TMPDIR:-/tmp}/codex-usage-cache.$(id -u).json"
CACHE_STAMP="${CACHE_FILE}.ts"
CACHE_TTL="${CODEX_USAGE_CACHE_TTL:-120}"   # seconds
RPC_TIMEOUT="${CODEX_USAGE_RPC_TIMEOUT:-20}" # seconds, whole exchange

MODE=human
USE_CACHE=1

for arg in "$@"; do
  case "$arg" in
    --json)     MODE=json ;;
    --compact)  MODE=compact ;;
    --no-cache) USE_CACHE=0 ;;
    -h|--help)  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

command -v jq    >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }
command -v codex >/dev/null 2>&1 || { echo "codex not found on PATH" >&2; exit 1; }

die() { echo "$*" >&2; exit 1; }

# --- cache (no stat: GNU and BSD disagree on its flags) --------------------

cache_is_fresh() {
  [[ -s "$CACHE_FILE" && -s "$CACHE_STAMP" ]] || return 1
  local stamp now
  stamp=$(cat "$CACHE_STAMP" 2>/dev/null) || return 1
  [[ "$stamp" =~ ^[0-9]+$ ]] || return 1
  now=$(date +%s)
  (( now - stamp < CACHE_TTL ))
}

write_cache() {
  printf '%s' "$1" > "${CACHE_FILE}.tmp" && mv "${CACHE_FILE}.tmp" "$CACHE_FILE"
  date +%s > "${CACHE_STAMP}.tmp" && mv "${CACHE_STAMP}.tmp" "$CACHE_STAMP"
}

# --- JSON-RPC over the app-server -----------------------------------------

CODEX_PID=""
cleanup() {
  [[ -n "$CODEX_PID" ]] && kill "$CODEX_PID" 2>/dev/null || true
}
trap cleanup EXIT

send() { printf '%s\n' "$1" >&"${CODEX[1]}"; }

# Read lines until one carries the requested id. Returns the whole line.
# Notifications and unrelated ids are discarded. Bounded by RPC_TIMEOUT so a
# silent server can't hang the script.
await_id() {
  local want="$1" line id deadline
  deadline=$(( $(date +%s) + RPC_TIMEOUT ))
  while (( $(date +%s) < deadline )); do
    if IFS= read -r -t 2 -u "${CODEX[0]}" line; then
      [[ -n "$line" ]] || continue
      id=$(printf '%s' "$line" | jq -r 'if type == "object" then (.id // empty) else empty end' 2>/dev/null) || continue
      [[ "$id" == "$want" ]] || continue
      printf '%s' "$line"
      return 0
    fi
  done
  return 1
}

fetch_rate_limits() {
  # stderr is kept off the protocol stream; drop it so a chatty build can't
  # deadlock on a full pipe.
  # coproc exports the child pid as CODEX_PID, which the EXIT trap reaps.
  coproc CODEX { codex app-server 2>/dev/null; }

  local init resp err
  send '{"id":0,"method":"initialize","params":{"clientInfo":{"name":"codex-usage","title":"codex-usage.sh","version":"1.0.0"}}}'

  # Wait for the real initialize response rather than sleeping — calling
  # account/rateLimits/read too early can come back empty.
  init=$(await_id 0) || die "no response to initialize within ${RPC_TIMEOUT}s (is 'codex app-server' supported on your version? needs >= 0.130)"
  err=$(printf '%s' "$init" | jq -r '.error.message // empty')
  [[ -z "$err" ]] || die "initialize failed: $err"

  send '{"method":"initialized"}'
  send '{"id":1,"method":"account/rateLimits/read","params":{}}'

  resp=$(await_id 1) || die "no response to account/rateLimits/read within ${RPC_TIMEOUT}s"
  err=$(printf '%s' "$resp" | jq -r '.error.message // empty')
  [[ -z "$err" ]] || die "account/rateLimits/read failed: $err (are you signed in with a ChatGPT plan rather than an API key?)"

  local limits
  limits=$(printf '%s' "$resp" | jq -c '.result.rateLimits // .result // {}')
  [[ "$limits" != "{}" && "$limits" != "null" ]] \
    || die "no rate limit data returned — API-key accounts have no plan windows, and some accounts expose only one window"

  write_cache "$limits"
  printf '%s' "$limits"
}

if (( USE_CACHE )) && cache_is_fresh; then
  DATA=$(cat "$CACHE_FILE")
else
  if ! DATA=$(fetch_rate_limits); then
    [[ -s "$CACHE_FILE" ]] || exit 1
    echo "warning: fetch failed, showing cached data" >&2
    DATA=$(cat "$CACHE_FILE")
  fi
fi

# --- output ----------------------------------------------------------------

if [[ "$MODE" == json ]]; then
  printf '%s\n' "$DATA" | jq .
  exit 0
fi

# Window names come from the duration, not from the primary/secondary labels —
# which window is "primary" varies by account state.
JQ_COMMON='
  def winlabel:
    if   . == null  then "window"
    elif . <= 60    then "\(.)m limit"
    elif . < 1440   then "\(. / 60 | floor)h limit"
    elif . == 1440  then "daily limit"
    elif . == 10080 then "weekly limit"
    elif . >= 40000 and . <= 46000 then "monthly limit"
    else "\(. / 1440 | floor)d limit" end;

  def pct: if . == null then null else (. | floor) end;

  def when:
    if . == null then ""
    else ((if . > 100000000000 then . / 1000 else . end) | floor) as $t
      | ($t - now | floor) as $d
      | if $d <= 0 then " (reset due)"
        elif $d < 3600 then " (resets in \($d / 60 | floor)m)"
        elif $d < 86400 then " (resets in \($d / 3600 | floor)h\(($d % 3600) / 60 | floor)m)"
        else " (resets \($t | strftime("%a %d %b %H:%MZ")))" end
    end;

  def rows:
    to_entries
    | map(select(.value | type == "object"))
    | map({
        mins:  (.value.windowDurationMins // .value.window_duration_mins // null),
        used:  (.value.usedPercent // .value.used_percent // null | pct),
        reset: (.value.resetsAt // .value.resets_at // null)
      })
    # `credits` is an object too, but it is not a window. Only a reported
    # duration makes an entry a rate limit.
    | map(select(.mins != null))
    | map({ name: (.mins | winlabel), used, reset });
'

if [[ "$MODE" == compact ]]; then
  printf '%s' "$DATA" | jq -r "$JQ_COMMON"'
    rows
    | map("\(.name | sub(" limit"; "")):\(if .used == null then "?" else "\(.used)%" end)")
    | join(" ")
  '
  exit 0
fi

printf '%s' "$DATA" | jq -r "$JQ_COMMON"'
  rows
  | if length == 0 then "no rate limit windows reported"
    else
      map("\(.name): \(if .used == null then "n/a" else "\(.used)% used, \(100 - .used)% left" end)\(.reset | when)")
      | .[]
    end
'
