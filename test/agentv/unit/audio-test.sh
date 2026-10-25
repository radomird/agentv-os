#!/bin/bash

# Guards the box's sound output (S2.19): the screen daemon's rules
# (daemon/audio.ts) with Node's own test runner, then agentv-audio-default,
# which first boot and a migration run, against a stand-in pactl.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/audio.test.mts"

mkdir -p "$SCRATCH/bin" "$SCRATCH/home"
cat >"$SCRATCH/bin/pactl" <<'FAKE'
#!/bin/bash
echo "$*" >>"$CALLS"
case "$1" in
  get-default-sink) [[ -n ${FAKE_SINK:-} ]] && echo "$FAKE_SINK" || exit 1 ;;
  set-sink-volume) exit "${FAKE_SET:-0}" ;;
esac
FAKE
chmod +x "$SCRATCH/bin/pactl"
export CALLS="$SCRATCH/calls"
hdmi=alsa_output.pci-0000_00_1f.3.hdmi-stereo
run() {
  : >"$CALLS"
  PATH="$SCRATCH/bin:$PATH" HOME="$SCRATCH/home" XDG_RUNTIME_DIR="$SCRATCH" "$ROOT/bin/agentv-audio-default" >"$SCRATCH/out" 2>&1
}

FAKE_SINK=$hdmi run || fail "agentv-audio-default runs" "$(cat "$SCRATCH/out")"
conf="$SCRATCH/home/.config/wireplumber/wireplumber.conf.d/50-agentv-volume.conf"
grep -q "device.routes.default-sink-volume = 1.0" "$conf" || fail "WirePlumber starts new outputs at full volume" "$(cat "$conf" 2>/dev/null)"
grep -qx "set-sink-volume $hdmi 100%" "$CALLS" || fail "the output playing goes to 100%" "$(cat "$CALLS")"
pass "S2.19 new outputs start at full volume, and the one playing goes to 100% now"

mkdir -p "$SCRATCH/home/.local/state/agentv"
printf '{"levels": {"%s": 0.6}}\n' "$hdmi" >"$SCRATCH/home/.local/state/agentv/audio.json"
FAKE_SINK=$hdmi run || fail "agentv-audio-default runs with a level chosen" "$(cat "$SCRATCH/out")"
! grep -q "set-sink-volume" "$CALLS" || fail "a level chosen in Settings stays" "$(cat "$CALLS")"
pass "S2.19 an output with a level chosen in Settings keeps it"

FAKE_SINK=easyeffects_sink run || fail "agentv-audio-default runs with a filter as the default" "$(cat "$SCRATCH/out")"
! grep -q "set-sink-volume" "$CALLS" || fail "a filter's volume is left alone" "$(cat "$CALLS")"
FAKE_SINK="" run || fail "with no PipeWire, as at first boot, it still succeeds" "$(cat "$SCRATCH/out")"
FAKE_SINK=alsa_output.usb FAKE_SET=1 run || fail "a volume that won't set doesn't fail an update" "$(cat "$SCRATCH/out")"
pass "with no PipeWire yet, a filter as the default or a volume that won't set, it still succeeds, so neither first boot nor an update stops"
