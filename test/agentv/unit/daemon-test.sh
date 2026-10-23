#!/bin/bash

# Guards the placeholder daemon behind S0.1: it serves the welcome page and
# the logo, answers /health, and only reports the welcome screen as shown
# once the page has told it so. CI's image check reads that /health.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
AGENTV_PATH="$ROOT" python3 "$ROOT/daemon/placeholder.py" --port "$port" >"$SCRATCH/daemon.log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -rf "$SCRATCH"' EXIT

url="http://127.0.0.1:$port"
for _ in $(seq 1 50); do
  curl -fsS -o /dev/null "$url/health" 2>/dev/null && break
  sleep 0.1
done

health=$(curl -fsS "$url/health") || fail "/health answers" "$(cat "$SCRATCH/daemon.log")"
[[ $(jq -r '.ok, .screen, .welcome_shown' <<<"$health" | paste -sd ' ' -) == "true welcome false" ]] ||
  fail "/health starts on the welcome screen, not yet shown" "$health"
pass "/health starts on the welcome screen, not yet shown"

page=$(curl -fsS "$url/")
[[ $page == *"<h1>Hi.</h1>"* && $page == *"/api/welcome-shown"* ]] || fail "the welcome page is served, and reports itself"
pass "the welcome page is served, and reports itself"

curl -fsS -o /dev/null "$url/logo.svg" || fail "the logo is served"
pass "the logo is served"

[[ $(curl -s -o /dev/null -w '%{http_code}' -X POST "$url/api/welcome-shown") == "204" ]] ||
  fail "the page can report that it's shown"
health=$(curl -fsS "$url/health")
[[ $(jq -r '.welcome_shown' <<<"$health") == "true" && $(jq -r '.welcome_shown_at' <<<"$health") != "null" ]] ||
  fail "/health then says the welcome screen is shown" "$health"
pass "/health then says the welcome screen is shown, and when"

first=$(jq -r '.welcome_shown_at' <<<"$health")
curl -fsS -o /dev/null -X POST "$url/api/welcome-shown" || fail "the page can report again"
health=$(curl -fsS "$url/health")
[[ $(jq -r '.welcome_shown_count' <<<"$health") == "2" && $(jq -r '.welcome_shown_at' <<<"$health") == "$first" &&
  $(jq -r '.welcome_last_shown_at' <<<"$health") != "null" ]] ||
  fail "a second draw counts, and the first time stays" "$health"
pass "every draw counts, with the first and the last time (S1.3, S1.6)"

[[ $(curl -s -o /dev/null -w '%{http_code}' "$url/../../etc/passwd") == "404" ]] ||
  fail "anything else is a 404"
pass "anything else is a 404"
