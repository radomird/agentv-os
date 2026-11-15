#!/bin/bash

# Guards origaitv-zone-set (ADR-055): a zone the daemon hands over is set with
# timedatectl when zone.tab lists it, and refused when it doesn't, without
# echoing what was dropped; the drop goes either way; origaitv-zone.path
# watches the daemon's drop, and the service runs it as root.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

export ORIGAITV_ZONE_DROP="$SCRATCH/drop/zone.json" ORIGAITV_ZONE_TAB="$ROOT/test/origaitv/fixtures/met/zone.tab"
mkdir -p "$SCRATCH/drop" "$SCRATCH/bin"
cat >"$SCRATCH/bin/timedatectl" <<SH
#!/bin/bash
printf '%s\n' "\$*" >>"$SCRATCH/calls"
SH
chmod +x "$SCRATCH/bin/timedatectl"
export PATH="$SCRATCH/bin:$PATH"
set_zone() {
  "$ROOT/bin/origaitv-zone-set" >"$SCRATCH/out" 2>&1
}

set_zone || fail "with nothing handed over, it does nothing" "$(cat "$SCRATCH/out")"
[[ ! -e $SCRATCH/calls ]] || fail "and sets nothing"

printf '{"zone":"America/New_York"}' >"$ORIGAITV_ZONE_DROP"
set_zone || fail "a zone zone.tab lists is set" "$(cat "$SCRATCH/out")"
[[ $(cat "$SCRATCH/calls") == "set-timezone America/New_York" ]] || fail "with timedatectl" "$(cat "$SCRATCH/calls")"
[[ ! -e $ORIGAITV_ZONE_DROP ]] || fail "the drop is gone"
grep -qx "origaitv-zone-set: the box's time zone is America/New_York" "$SCRATCH/out" || fail "it says which" "$(cat "$SCRATCH/out")"
pass "ADR-055 a zone handed over is set with timedatectl, and the drop goes"

: >"$SCRATCH/calls"
for zone in 'Europe/Atlantis' '../../etc/passwd' 'Europe/Oslo; reboot' 'UTC'; do
  jq -cn --arg zone "$zone" '{zone: $zone}' >"$ORIGAITV_ZONE_DROP"
  if set_zone; then fail "a zone zone.tab doesn't list is refused: $zone"; fi
  [[ ! -e $ORIGAITV_ZONE_DROP ]] || fail "and its drop is gone too: $zone"
  if grep -qF "$zone" "$SCRATCH/out"; then fail "and what was dropped isn't echoed: $zone"; fi
done
printf 'not json' >"$ORIGAITV_ZONE_DROP"
if set_zone; then fail "a drop that isn't json is refused"; fi
[[ ! -s $SCRATCH/calls ]] || fail "nothing refused reaches timedatectl" "$(cat "$SCRATCH/calls")"
pass "a zone zone.tab doesn't list, or a drop that isn't one, changes nothing and isn't echoed"

grep -qx "PathExists=/var/lib/origaitv/daemon/zone-drop/zone.json" "$ROOT/system/origaitv-zone.path" || fail "origaitv-zone.path watches the daemon's drop"
grep -qx "WantedBy=paths.target" "$ROOT/system/origaitv-zone.path" || fail "and is enabled with the others"
grep -qx "ExecStart=/usr/bin/origaitv-zone-set" "$ROOT/system/origaitv-zone.service" || fail "origaitv-zone.service runs origaitv-zone-set"
if grep -q "^User=\|^DynamicUser=" "$ROOT/system/origaitv-zone.service"; then fail "as root"; fi
grep -qx "sudo systemctl start origaitv-zone.path || true" "$(grep -l "origaitv-zone.path" "$ROOT"/migrations/origaitv/*.sh)" || fail "boxes installed before start the hand-over"
pass "origaitv-zone.path hands the zone to origaitv-zone.service, as root, and boxes installed before start it"
