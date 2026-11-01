#!/bin/bash

# Guards agentv-voice-fetch (stage 8): with Piper here already it does
# nothing; a file that doesn't match its checksum, or that can't be
# fetched, leaves nothing behind; either way the daemon's drop is gone, so
# the daemon can ask again later. The real fetch runs in the image layer.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

export AGENTV_VOICE_DIR="$SCRATCH/voice" AGENTV_VOICE_DROP="$SCRATCH/drop/fetch" AGENTV_VOICE_BASE="file://$SCRATCH/mirror"
mkdir -p "$SCRATCH/drop" "$SCRATCH/mirror/2023.11.14-2" "$SCRATCH/mirror/en/en_GB/cori/medium"
fetch() {
  touch "$AGENTV_VOICE_DROP"
  "$ROOT/bin/agentv-voice-fetch" >"$SCRATCH/out" 2>&1
}

if fetch; then fail "with nothing to fetch, it fails"; fi
grep -q "couldn't fetch piper.tar.gz" "$SCRATCH/out" || fail "and says what it couldn't fetch" "$(cat "$SCRATCH/out")"
[[ ! -e $AGENTV_VOICE_DROP ]] || fail "the drop is gone, so the daemon asks again later"
[[ ! -e $AGENTV_VOICE_DIR/ready ]] || fail "and nothing says it's ready"
pass "a fetch that doesn't work leaves nothing, and takes the drop away"

echo "not piper" >"$SCRATCH/mirror/2023.11.14-2/piper_linux_x86_64.tar.gz"
if fetch; then fail "a file that isn't the one it should be is refused"; fi
grep -q "piper.tar.gz isn't the file it should be" "$SCRATCH/out" || fail "and it says so" "$(cat "$SCRATCH/out")"
[[ ! -e $AGENTV_VOICE_DIR/piper ]] || fail "and nothing of it is kept"
pass "a file that doesn't match its checksum isn't kept"

mkdir -p "$AGENTV_VOICE_DIR"
touch "$AGENTV_VOICE_DIR/ready"
fetch || fail "with Piper here already, it does nothing" "$(cat "$SCRATCH/out")"
grep -q "Piper is here already" "$SCRATCH/out" || fail "and says so"
[[ ! -e $AGENTV_VOICE_DROP ]] || fail "and takes the drop away"
pass "with Piper here already, it fetches nothing"

for word in StateDirectory=agentv/voice ProtectSystem=strict NoNewPrivileges=yes "ExecStart=/usr/bin/agentv-voice-fetch"; do
  grep -qx "$word" "$ROOT/system/agentv-voice.service" || fail "agentv-voice.service has $word"
done
grep -qx "PathExists=/var/lib/private/agentv/daemon/voice-drop/fetch" "$ROOT/system/agentv-voice.path" || fail "agentv-voice.path watches the daemon's drop"
pass "agentv-voice.path fetches as root when the daemon asks, into its own folder only"
