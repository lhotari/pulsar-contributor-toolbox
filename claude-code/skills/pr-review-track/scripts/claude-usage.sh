#!/usr/bin/env bash
#
# claude-usage.sh — read Claude subscription usage from the OAuth usage endpoint.
#
# Token source:
#   macOS  : login Keychain, service "Claude Code-credentials" (falls back to the
#            legacy "Claude Code" service name, then to the file below)
#   Linux  : ~/.claude/.credentials.json
#
# Usage:
#   ./claude-usage.sh              # human-readable
#   ./claude-usage.sh --json       # raw JSON from the endpoint
#   ./claude-usage.sh --no-cache   # bypass the cache
#
# NOTE: the endpoint is undocumented and unsupported. It can change or disappear.
#       Reading the Keychain item with `security -w` looks identical to credential
#       exfiltration to EDR tooling — baseline this script if your Mac is managed.

set -euo pipefail

USAGE_URL="https://api.anthropic.com/api/oauth/usage"
OAUTH_BETA="oauth-2025-04-20"
CREDS_FILE="${HOME}/.claude/.credentials.json"
CACHE_FILE="${TMPDIR:-/tmp}/claude-usage-cache.$(id -u).json"
CACHE_TTL="${CLAUDE_USAGE_CACHE_TTL:-120}"   # seconds
CURL_TIMEOUT=5

OUTPUT_JSON=0
USE_CACHE=1

for arg in "$@"; do
  case "$arg" in
    --json)     OUTPUT_JSON=1 ;;
    --no-cache) USE_CACHE=0 ;;
    -h|--help)  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }

die() { echo "$*" >&2; exit 1; }

# --- token retrieval -------------------------------------------------------

# Returns the whole credentials JSON blob on stdout. The Keychain payload and
# the file have the same shape, so callers can treat them identically.
read_credentials() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    local blob
    for service in "Claude Code-credentials" "Claude Code"; do
      if blob=$(security find-generic-password -s "$service" -a "$USER" -w 2>/dev/null); then
        printf '%s' "$blob"
        return 0
      fi
      # Some installs wrote the item without an account attribute.
      if blob=$(security find-generic-password -s "$service" -w 2>/dev/null); then
        printf '%s' "$blob"
        return 0
      fi
    done
    # Fall through to the file: it exists on Macs where the Keychain was
    # unavailable (SSH sessions) and the credentials were dumped manually.
  fi

  if [[ -r "$CREDS_FILE" ]]; then
    cat "$CREDS_FILE"
    return 0
  fi

  return 1
}

get_token() {
  local blob token
  blob=$(read_credentials) || die "no credentials found (Keychain item 'Claude Code-credentials' and $CREDS_FILE both unavailable). Over SSH the Keychain is unreachable — run 'claude' locally once, or dump the item to $CREDS_FILE from a local terminal."

  token=$(printf '%s' "$blob" | jq -r '.claudeAiOauth.accessToken // empty' 2>/dev/null) \
    || die "credentials payload is not valid JSON"
  [[ -n "$token" ]] || die "credentials found but no .claudeAiOauth.accessToken in them"

  # Warn if the stored token looks expired; the endpoint will 401 anyway.
  local expires_at now
  expires_at=$(printf '%s' "$blob" | jq -r '.claudeAiOauth.expiresAt // empty')
  if [[ -n "$expires_at" ]]; then
    now=$(( $(date +%s) * 1000 ))
    if (( expires_at < now )); then
      echo "warning: stored token expired; run 'claude' once to refresh it" >&2
    fi
  fi

  printf '%s' "$token"
}

# --- fetch -----------------------------------------------------------------

# Epoch mtime of $1, or nothing if it can't be determined. Probe both stat
# dialects rather than branching on uname: a Mac with Homebrew coreutils on
# PATH has GNU stat, where -f means --file-system and prints the wrong thing.
file_mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null
}

cache_is_fresh() {
  [[ -s "$CACHE_FILE" ]] || return 1
  local mtime now
  mtime=$(file_mtime "$CACHE_FILE")
  [[ "$mtime" =~ ^[0-9]+$ ]] || return 1
  now=$(date +%s)
  (( now - mtime < CACHE_TTL ))
}

fetch_usage() {
  local token body status
  token=$(get_token)

  body=$(curl -sS --max-time "$CURL_TIMEOUT" -w '\n%{http_code}' "$USAGE_URL" \
    -H "Authorization: Bearer ${token}" \
    -H "anthropic-beta: ${OAUTH_BETA}") || die "request failed"

  status="${body##*$'\n'}"
  body="${body%$'\n'*}"

  case "$status" in
    200) ;;
    401|403) die "auth rejected (HTTP $status) — token may be stale, or the endpoint no longer accepts OAuth" ;;
    429) die "rate limited by the usage endpoint (HTTP 429); try again later" ;;
    *)   die "unexpected HTTP $status from usage endpoint" ;;
  esac

  printf '%s' "$body" | jq -e . >/dev/null 2>&1 || die "response was not JSON"
  printf '%s' "$body" > "${CACHE_FILE}.tmp" && mv "${CACHE_FILE}.tmp" "$CACHE_FILE"
  printf '%s' "$body"
}

if (( USE_CACHE )) && cache_is_fresh; then
  DATA=$(cat "$CACHE_FILE")
else
  # On failure, fall back to a stale cache rather than printing nothing.
  if ! DATA=$(fetch_usage); then
    [[ -s "$CACHE_FILE" ]] || exit 1
    echo "warning: fetch failed, showing cached data" >&2
    DATA=$(cat "$CACHE_FILE")
  fi
fi

# --- output ----------------------------------------------------------------

if (( OUTPUT_JSON )); then
  printf '%s\n' "$DATA" | jq .
  exit 0
fi

printf '%s' "$DATA" | jq -r '
  def pct:
    if . == null then "n/a"
    elif type == "string" then .
    else "\(floor)%" end;

  # resets_at may arrive as an ISO-8601 string, epoch seconds, or epoch
  # milliseconds. todate only accepts numbers, so branch on the type.
  def reset:
    if . == null or . == "" then ""
    elif type == "number" then
      " (resets \((if . > 100000000000 then . / 1000 else . end) | floor | todate))"
    else " (resets \(.))"
    end;

  [
    "session (5h): \(.five_hour.utilization // .five_hour.used_percentage | pct)\(.five_hour.resets_at // null | reset)",
    "week (all):   \(.seven_day.utilization // .seven_day.used_percentage | pct)\(.seven_day.resets_at // null | reset)"
  ] | .[]
'
