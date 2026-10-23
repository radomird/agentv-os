#!/bin/bash

# Guards daemon/tv-power.ts (ADR-004, ADR-031): whether the TV is on, from the
# HDMI connector's status, then the HDMI audio's ELD, against stand-ins for
# /sys/class/drm and /proc/asound.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

if ! type -P node >/dev/null; then
  [[ -n ${CI:-} ]] && fail "Node is installed" "the TV power check needs Node 22.18 or newer"
  echo "skip - the TV power check (Node isn't installed)"
  exit 0
fi

drm="$SCRATCH/drm"
asound="$SCRATCH/asound"
mkdir -p "$drm/card1-HDMI-A-1" "$drm/card1-eDP-1" "$asound/card0"

on() {
  node_eval "import { tvOn } from '$ROOT/daemon/tv-power.ts'; console.log(String(tvOn('$drm', '$asound')))"
}

echo connected >"$drm/card1-eDP-1/status"
[[ $(on) == "null" ]] || fail "a laptop's own panel isn't a TV" "$(on)"
echo connected >"$drm/card1-HDMI-A-1/status"
[[ $(on) == "true" ]] || fail "with no HDMI audio to ask, a connected TV is on" "$(on)"
printf 'monitor_present\t1\neld_valid\t1\nmonitor_name\tTV\n' >"$asound/card0/eld#0.0"
[[ $(on) == "true" ]] || fail "a TV offering its audio is on" "$(on)"
printf 'monitor_present\t0\neld_valid\t0\n' >"$asound/card0/eld#0.0"
[[ $(on) == "false" ]] || fail "a TV still connected but no longer offering its audio is off" "$(on)"
printf 'monitor_present\t1\n' >"$asound/card0/eld#0.1"
[[ $(on) == "true" ]] || fail "one port with the TV is enough" "$(on)"
echo disconnected >"$drm/card1-HDMI-A-1/status"
[[ $(on) == "false" ]] || fail "a disconnected TV is off" "$(on)"
pass "S2.8 the TV's power comes from its connector, then its audio"
