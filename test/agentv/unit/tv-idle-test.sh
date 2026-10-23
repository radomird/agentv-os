#!/bin/bash

# Guards bin/agentv-tv-idle: Omarchy's idle lock goes off in the owner's
# shell.json, which otherwise stays as it was, and suspend leaves Omarchy's
# menu (ADR-009, ADR-029).

# shellcheck disable=SC2016 # the fakes' bodies are run later, by the script under test
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

bin="$SCRATCH/bin"
mkdir -p "$bin" "$SCRATCH/omarchy/config/omarchy"
printf '{"version": 1, "idle": {"screensaver": 150, "lock": 300}, "bar": {"position": "top"}}\n' \
  >"$SCRATCH/omarchy/config/omarchy/shell.json"

fake() {
  printf '#!/bin/bash\n%s\n' "$2" >"$bin/$1"
  chmod +x "$bin/$1"
}

fake omarchy-toggle 'echo "toggle $*" >>"$CALLS"'
fake omarchy-shell 'echo "shell $*" >>"$CALLS"'

idle() {
  rm -f "$SCRATCH/calls"
  env PATH="$bin:$PATH" HOME="$SCRATCH/home" CALLS="$SCRATCH/calls" OMARCHY_PATH="$SCRATCH/omarchy" \
    "$BASH" "$ROOT/bin/agentv-tv-idle"
}

config="$SCRATCH/home/.config/omarchy/shell.json"

idle || fail "it runs without a shell.json of the owner's"
[[ $(jq -c '.idle' "$config") == '{"screensaver":150,"lock":0}' ]] || fail "the lock goes off and the screensaver stays" "$(cat "$config")"
[[ $(jq -r '.bar.position' "$config") == top ]] || fail "Omarchy's defaults carry over" "$(cat "$config")"
grep -qx "toggle suspend-off on" "$SCRATCH/calls" || fail "suspend leaves Omarchy's menu" "$(cat "$SCRATCH/calls")"
grep -qx "shell shell reloadConfig" "$SCRATCH/calls" || fail "a running shell takes it now"
pass "from Omarchy's defaults: the idle lock off, the screensaver kept, suspend out of the menu"

printf '{"version": 1, "idle": {"screensaver": 600, "lock": 900}, "bar": {"position": "bottom"}}\n' >"$config"
idle || fail "it runs with the owner's own shell.json"
[[ $(jq -c '.idle' "$config") == '{"screensaver":600,"lock":0}' ]] || fail "only the lock changes" "$(cat "$config")"
[[ $(jq -r '.bar.position' "$config") == bottom ]] || fail "the owner's own settings stay" "$(cat "$config")"
pass "with the owner's own shell.json: only the idle lock changes"

idle || fail "it runs twice"
[[ $(jq -c '.idle' "$config") == '{"screensaver":600,"lock":0}' ]] || fail "running it again changes nothing"
pass "running it again changes nothing"
