#!/usr/bin/env bash
# Project status line: 5-hour rolling session usage + total input/output tokens.
# Reads the status line JSON payload from stdin (see Claude Code statusLine docs).

set -euo pipefail

input="$(cat)"

# Human-readable token counts: 950 -> 950, 74640 -> 74.6k, 1500000 -> 1.5M
humanize() {
  awk -v n="$1" 'BEGIN {
    if (n >= 1000000)      printf "%.1fM", n / 1000000
    else if (n >= 1000)    printf "%.1fk", n / 1000
    else                   printf "%d", n
  }'
}

# Countdown to a unix-epoch reset time: -> "2h13m", "47m", or "now"
until_reset() {
  local target="$1" now diff
  now="$(date +%s)"
  diff=$(( target - now ))
  if (( diff <= 0 )); then
    printf "now"
  elif (( diff >= 3600 )); then
    printf "%dh%02dm" $(( diff / 3600 )) $(( (diff % 3600) / 60 ))
  else
    printf "%dm" $(( diff / 60 ))
  fi
}

model="$(printf '%s' "$input" | jq -r '.model.display_name // "?"')"
five_pct="$(printf '%s' "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')"
five_reset="$(printf '%s' "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')"
in_tok="$(printf '%s' "$input" | jq -r '.context_window.total_input_tokens // 0')"
out_tok="$(printf '%s' "$input" | jq -r '.context_window.total_output_tokens // 0')"

# 5-hour session usage segment
if [[ -n "$five_pct" ]]; then
  five="5h ${five_pct}%"
  [[ -n "$five_reset" ]] && five="${five} (resets $(until_reset "$five_reset"))"
else
  five="5h —"
fi

# Total token usage segment
tokens="in $(humanize "$in_tok") · out $(humanize "$out_tok")"

printf '%s │ %s │ %s' "$model" "$five" "$tokens"
