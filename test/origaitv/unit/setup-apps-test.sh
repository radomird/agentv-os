#!/bin/bash

# Guards setup's apps (board 09): the official apps for the goal first, from
# the signed index, the ones picked handed to root past the PIN, the TV told
# as each installs, and the apps asked for at add your own kept for later.
# Then origaitv-setup-apps, root's side: it installs each app the daemon left,
# one after the other, with an official native app's program (ADR-042), says
# how each went, and leaves out anything that isn't an app id.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/origaitv/unit/setup-apps.test.mts"

export ORIGAITV_SETUP_APPS_DROP="$SCRATCH/drop/install.json" ORIGAITV_SETUP_APPS_STATUS="$SCRATCH/run/state.json" ORIGAITV_APP_INSTALL="$SCRATCH/install"
export ORIGAITV_APPS="$SCRATCH/apps" ORIGAITV_APP_PACKAGE="$SCRATCH/package" ORIGAITV_APP_PACKAGE_ERRORS="$SCRATCH/package-errors"
mkdir -p "$SCRATCH/drop" "$ORIGAITV_APPS"
echo '{}' >"$ORIGAITV_APPS/installed.json"
# A stand-in for origaitv app install: Steam can't be fetched, the rest install.
cat >"$ORIGAITV_APP_INSTALL" <<'STUB'
#!/bin/bash
echo "$1" >>"${0%/*}/installed"
if [[ $1 == origaitv.steam ]]; then
  echo "Couldn't do it: couldn't fetch origaitv.steam from https://example.invalid/origaitv-apps.git."
  exit 1
fi
echo "Installed $1 1.0.0 ($1)."
STUB
chmod +x "$ORIGAITV_APP_INSTALL"
run() {
  "$ROOT/bin/origaitv-setup-apps" >"$SCRATCH/out" 2>&1
}

run || fail "with nothing handed over, it does nothing" "$(cat "$SCRATCH/out")"
[[ ! -e $ORIGAITV_SETUP_APPS_STATUS ]] || fail "and writes nothing"

printf '%s' '{"apps":["origaitv.immich","../etc/passwd","origaitv.steam","origaitv.jellyfin"]}' >"$ORIGAITV_SETUP_APPS_DROP"
run || fail "it goes through every app" "$(cat "$SCRATCH/out")"
[[ ! -e $ORIGAITV_SETUP_APPS_DROP ]] || fail "the drop is gone"
[[ $(cat "$SCRATCH/installed") == $'origaitv.immich\norigaitv.steam\norigaitv.jellyfin' ]] || fail "it installs each app id in turn, and nothing else" "$(cat "$SCRATCH/installed")"
jq -e '.apps["origaitv.immich"].state == "installed" and .apps["origaitv.jellyfin"].state == "installed"' "$ORIGAITV_SETUP_APPS_STATUS" >/dev/null || fail "the status says which installed" "$(cat "$ORIGAITV_SETUP_APPS_STATUS")"
jq -e '.apps["origaitv.steam"] | .state == "failed" and .error == "couldn'"'"'t fetch origaitv.steam from https://example.invalid/origaitv-apps.git"' "$ORIGAITV_SETUP_APPS_STATUS" >/dev/null || fail "and which didn't, with the installer's own reason" "$(cat "$ORIGAITV_SETUP_APPS_STATUS")"
jq -e '.apps | has("../etc/passwd") | not' "$ORIGAITV_SETUP_APPS_STATUS" >/dev/null || fail "something that isn't an app id is left out"
[[ $(stat -c %a "$ORIGAITV_SETUP_APPS_STATUS") == 644 ]] || fail "and the TV can read the status"
pass "each app the daemon handed over is installed in turn, and the status says how each went"

printf '%s' '{"apps":["origaitv.steam"]}' >"$ORIGAITV_SETUP_APPS_DROP"
run || fail "a second hand-over" "$(cat "$SCRATCH/out")"
jq -e '.apps["origaitv.immich"].state == "installed" and .apps["origaitv.steam"].state == "failed"' "$ORIGAITV_SETUP_APPS_STATUS" >/dev/null || fail "keeps what the first said" "$(cat "$ORIGAITV_SETUP_APPS_STATUS")"
pass "a second hand-over adds to the status"

# ADR-042: an official native app's program comes with it. The installer
# stand-in puts each app where origaitv app install would, with its tier and
# manifest; pacman knows only bash; the program's unit is a stand-in too.
cat >"$ORIGAITV_APP_INSTALL" <<'STUB'
#!/bin/bash
apps=$ORIGAITV_APPS
case $1 in
  origaitv.game) tier=official manifest='{"tv":{"runtime":"native","package":{"pacman":"stand-in-game"},"exec":["stand-in-game"]}}' ;;
  origaitv.broken) tier=official manifest='{"tv":{"runtime":"native","package":{"pacman":"broken-game"},"exec":["broken-game"]}}' ;;
  origaitv.shell) tier=official manifest='{"tv":{"runtime":"native","package":{"pacman":"bash"},"exec":["bash"]}}' ;;
  someone.game) tier=community manifest='{"tv":{"runtime":"native","package":{"pacman":"stand-in-game"},"exec":["stand-in-game"]}}' ;;
  origaitv.web) tier=official manifest='{"tv":{"runtime":"web"}}' ;;
esac
mkdir -p "$apps/$1"
printf '%s' "$manifest" >"$apps/$1/manifest.json"
jq --arg id "$1" --arg tier "$tier" '.[$id] = {id: $id, tier: $tier}' "$apps/installed.json" >"$apps/installed.json.next" && mv "$apps/installed.json.next" "$apps/installed.json"
echo "Installed $1 1.0.0 ($1)."
STUB
cat >"$ORIGAITV_APP_PACKAGE" <<'STUB'
#!/bin/bash
echo "$1" >>"${0%/*}/programs"
if [[ $1 == origaitv.broken ]]; then
  mkdir -p "$ORIGAITV_APP_PACKAGE_ERRORS"
  echo "broken-game didn't install" >"$ORIGAITV_APP_PACKAGE_ERRORS/$1.error"
  exit 1
fi
STUB
mkdir -p "$SCRATCH/bin"
cat >"$SCRATCH/bin/pacman" <<'STUB'
#!/bin/bash
[[ $1 == -Q && ${3:-$2} == bash ]]
STUB
chmod +x "$ORIGAITV_APP_INSTALL" "$ORIGAITV_APP_PACKAGE" "$SCRATCH/bin/pacman"
printf '%s' '{"apps":["origaitv.game","origaitv.broken","origaitv.shell","someone.game","origaitv.web"]}' >"$ORIGAITV_SETUP_APPS_DROP"
PATH="$SCRATCH/bin:$PATH" run || fail "it goes through apps with programs" "$(cat "$SCRATCH/out")"
[[ $(cat "$SCRATCH/programs") == $'origaitv.game\norigaitv.broken' ]] || fail "only an official native app's missing program is installed" "$(cat "$SCRATCH/programs")"
jq -e '.apps["origaitv.game"].state == "installed" and .apps["origaitv.shell"].state == "installed" and .apps["someone.game"].state == "installed" and .apps["origaitv.web"].state == "installed"' "$ORIGAITV_SETUP_APPS_STATUS" >/dev/null || fail "an app is installed once its program is" "$(cat "$ORIGAITV_SETUP_APPS_STATUS")"
jq -e '.apps["origaitv.broken"] | .state == "failed" and .error == "broken-game didn'"'"'t install"' "$ORIGAITV_SETUP_APPS_STATUS" >/dev/null || fail "and failed, with why, when its program didn't install" "$(cat "$ORIGAITV_SETUP_APPS_STATUS")"
grep -qx "TimeoutStartSec=90min" "$ROOT/system/origaitv-setup-apps.service" || fail "origaitv-setup-apps.service waits long enough for a program like Steam"
pass "ADR-042 an official native app's program comes with it, and its tile says when it didn't"

for word in ProtectSystem=strict NoNewPrivileges=yes StateDirectory=origaitv/apps RuntimeDirectory=origaitv-setup-apps ReadWritePaths=-/var/lib/origaitv/daemon; do
  grep -qx "$word" "$ROOT/system/origaitv-setup-apps.service" || fail "origaitv-setup-apps.service has $word"
done
grep -qx "PathExists=/var/lib/origaitv/daemon/apps-drop/install.json" "$ROOT/system/origaitv-setup-apps.path" || fail "origaitv-setup-apps.path watches the daemon's drop"
pass "origaitv-setup-apps.path starts the installs as root when the daemon leaves the apps picked"
