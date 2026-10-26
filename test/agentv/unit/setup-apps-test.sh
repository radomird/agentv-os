#!/bin/bash

# Guards setup's apps (board 09): the official apps for the goal first, from
# the signed index, the ones picked handed to root past the PIN, the TV told
# as each installs, and the apps asked for at add your own kept for later.
# Then agentv-setup-apps, root's side: it installs each app the daemon left,
# one after the other, says how each went, and leaves out anything that
# isn't an app id.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/setup-apps.test.mts"

export AGENTV_SETUP_APPS_DROP="$SCRATCH/drop/install.json" AGENTV_SETUP_APPS_STATUS="$SCRATCH/run/state.json" AGENTV_APP_INSTALL="$SCRATCH/install"
mkdir -p "$SCRATCH/drop"
# A stand-in for agentv app install: Steam can't be fetched, the rest install.
cat >"$AGENTV_APP_INSTALL" <<'STUB'
#!/bin/bash
echo "$1" >>"${0%/*}/installed"
if [[ $1 == agentv.steam ]]; then
  echo "Couldn't do it: couldn't fetch agentv.steam from https://example.invalid/agentv-apps.git."
  exit 1
fi
echo "Installed $1 1.0.0 ($1)."
STUB
chmod +x "$AGENTV_APP_INSTALL"
run() {
  "$ROOT/bin/agentv-setup-apps" >"$SCRATCH/out" 2>&1
}

run || fail "with nothing handed over, it does nothing" "$(cat "$SCRATCH/out")"
[[ ! -e $AGENTV_SETUP_APPS_STATUS ]] || fail "and writes nothing"

printf '%s' '{"apps":["agentv.immich","../etc/passwd","agentv.steam","agentv.jellyfin"]}' >"$AGENTV_SETUP_APPS_DROP"
run || fail "it goes through every app" "$(cat "$SCRATCH/out")"
[[ ! -e $AGENTV_SETUP_APPS_DROP ]] || fail "the drop is gone"
[[ $(cat "$SCRATCH/installed") == $'agentv.immich\nagentv.steam\nagentv.jellyfin' ]] || fail "it installs each app id in turn, and nothing else" "$(cat "$SCRATCH/installed")"
jq -e '.apps["agentv.immich"].state == "installed" and .apps["agentv.jellyfin"].state == "installed"' "$AGENTV_SETUP_APPS_STATUS" >/dev/null || fail "the status says which installed" "$(cat "$AGENTV_SETUP_APPS_STATUS")"
jq -e '.apps["agentv.steam"] | .state == "failed" and .error == "couldn'"'"'t fetch agentv.steam from https://example.invalid/agentv-apps.git"' "$AGENTV_SETUP_APPS_STATUS" >/dev/null || fail "and which didn't, with the installer's own reason" "$(cat "$AGENTV_SETUP_APPS_STATUS")"
jq -e '.apps | has("../etc/passwd") | not' "$AGENTV_SETUP_APPS_STATUS" >/dev/null || fail "something that isn't an app id is left out"
[[ $(stat -c %a "$AGENTV_SETUP_APPS_STATUS") == 644 ]] || fail "and the TV can read the status"
pass "each app the daemon handed over is installed in turn, and the status says how each went"

printf '%s' '{"apps":["agentv.steam"]}' >"$AGENTV_SETUP_APPS_DROP"
run || fail "a second hand-over" "$(cat "$SCRATCH/out")"
jq -e '.apps["agentv.immich"].state == "installed" and .apps["agentv.steam"].state == "failed"' "$AGENTV_SETUP_APPS_STATUS" >/dev/null || fail "keeps what the first said" "$(cat "$AGENTV_SETUP_APPS_STATUS")"
pass "a second hand-over adds to the status"

for word in ProtectSystem=strict NoNewPrivileges=yes StateDirectory=agentv/apps RuntimeDirectory=agentv-setup-apps ReadWritePaths=-/var/lib/private/agentv/daemon; do
  grep -qx "$word" "$ROOT/system/agentv-setup-apps.service" || fail "agentv-setup-apps.service has $word"
done
grep -qx "PathExists=/var/lib/private/agentv/daemon/apps-drop/install.json" "$ROOT/system/agentv-setup-apps.path" || fail "agentv-setup-apps.path watches the daemon's drop"
pass "agentv-setup-apps.path starts the installs as root when the daemon leaves the apps picked"
