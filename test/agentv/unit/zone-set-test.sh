#!/bin/bash

# Guards agentv-zone-set (ADR-055): a zone the daemon hands over is set with
# timedatectl when zone.tab lists it, and refused when it doesn't, without
# echoing what was dropped; the drop goes either way; agentv-zone.path
# watches the daemon's drop, and the service runs it as root.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

export AGENTV_ZONE_DROP="$SCRATCH/drop/zone.json" AGENTV_ZONE_TAB="$ROOT/test/agentv/fixtures/met/zone.tab"
mkdir -p "$SCRATCH/drop" "$SCRATCH/bin"
cat >"$SCRATCH/bin/timedatectl" <<SH
#!/bin/bash
printf '%s\n' "\$*" >>"$SCRATCH/calls"
SH
chmod +x "$SCRATCH/bin/timedatectl"
export PATH="$SCRATCH/bin:$PATH"
set_zone() {
  "$ROOT/bin/agentv-zone-set" >"$SCRATCH/out" 2>&1
}

set_zone || fail "with nothing handed over, it does nothing" "$(cat "$SCRATCH/out")"
[[ ! -e $SCRATCH/calls ]] || fail "and sets nothing"

printf '{"zone":"America/New_York"}' >"$AGENTV_ZONE_DROP"
set_zone || fail "a zone zone.tab lists is set" "$(cat "$SCRATCH/out")"
[[ $(cat "$SCRATCH/calls") == "set-timezone America/New_York" ]] || fail "with timedatectl" "$(cat "$SCRATCH/calls")"
[[ ! -e $AGENTV_ZONE_DROP ]] || fail "the drop is gone"
grep -qx "agentv-zone-set: the box's time zone is America/New_York" "$SCRATCH/out" || fail "it says which" "$(cat "$SCRATCH/out")"
pass "ADR-055 a zone handed over is set with timedatectl, and the drop goes"

: >"$SCRATCH/calls"
for zone in 'Europe/Atlantis' '../../etc/passwd' 'Europe/Oslo; reboot' 'UTC'; do
  jq -cn --arg zone "$zone" '{zone: $zone}' >"$AGENTV_ZONE_DROP"
  if set_zone; then fail "a zone zone.tab doesn't list is refused: $zone"; fi
  [[ ! -e $AGENTV_ZONE_DROP ]] || fail "and its drop is gone too: $zone"
  if grep -qF "$zone" "$SCRATCH/out"; then fail "and what was dropped isn't echoed: $zone"; fi
done
printf 'not json' >"$AGENTV_ZONE_DROP"
if set_zone; then fail "a drop that isn't json is refused"; fi
[[ ! -s $SCRATCH/calls ]] || fail "nothing refused reaches timedatectl" "$(cat "$SCRATCH/calls")"
pass "a zone zone.tab doesn't list, or a drop that isn't one, changes nothing and isn't echoed"

grep -qx "PathExists=/var/lib/agentv/daemon/zone-drop/zone.json" "$ROOT/system/agentv-zone.path" || fail "agentv-zone.path watches the daemon's drop"
grep -qx "WantedBy=paths.target" "$ROOT/system/agentv-zone.path" || fail "and is enabled with the others"
grep -qx "ExecStart=/usr/bin/agentv-zone-set" "$ROOT/system/agentv-zone.service" || fail "agentv-zone.service runs agentv-zone-set"
if grep -q "^User=\|^DynamicUser=" "$ROOT/system/agentv-zone.service"; then fail "as root"; fi
grep -qx "sudo systemctl start agentv-zone.path || true" "$(grep -l "agentv-zone.path" "$ROOT"/migrations/agentv/*.sh)" || fail "boxes installed before start the hand-over"
pass "agentv-zone.path hands the zone to agentv-zone.service, as root, and boxes installed before start it"
