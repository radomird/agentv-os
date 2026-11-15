#!/bin/bash

# Guards origaitv-app-package (ADR-042): the program an official native app
# opens, installed the way Omarchy's own installer does. For Steam that's
# the lib32 drivers first, then Steam, and never the installer's last step,
# which would start Steam as root. Only an official native app's package,
# by a name that's a package name, and why it didn't, for the TV.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

export ORIGAITV_APPS="$SCRATCH/apps" ORIGAITV_APP_PACKAGE_ERRORS="$SCRATCH/errors" OMARCHY_PATH="$SCRATCH/omarchy"
mkdir -p "$ORIGAITV_APPS" "$OMARCHY_PATH/bin"
calls="$SCRATCH/calls"

# Stand-ins for Omarchy's commands and pacman, which note each call. pacman
# knows only the packages in $SCRATCH/installed.
for name in omarchy-pkg-add omarchy-install-gaming-gpu-lib32 omarchy-install-gaming-steam uwsm-app gtk-launch; do
  cat >"$OMARCHY_PATH/bin/$name" <<STUB
#!/bin/bash
echo "$name \$*" >>"$calls"
[[ $name != omarchy-pkg-add ]] || [[ \$1 != broken-game ]]
STUB
done
cat >"$OMARCHY_PATH/bin/pacman" <<STUB
#!/bin/bash
grep -qx -- "\${3:-\$2}" "$SCRATCH/installed" 2>/dev/null
STUB
# The box's repositories, each with its package list.
cat >"$OMARCHY_PATH/bin/pacman-conf" <<'STUB'
#!/bin/bash
[[ $1 == --repo-list ]] && printf '%s\n' core extra multilib
STUB
chmod +x "$OMARCHY_PATH/bin/"*
echo bash >"$SCRATCH/installed"
export ORIGAITV_PACMAN_SYNC="$SCRATCH/sync"
mkdir -p "$ORIGAITV_PACMAN_SYNC"
touch "$ORIGAITV_PACMAN_SYNC/core.db" "$ORIGAITV_PACMAN_SYNC/extra.db" "$ORIGAITV_PACMAN_SYNC/multilib.db"

# app <id> <tier> <manifest>: an app where origaitv app install puts one.
app() {
  mkdir -p "$ORIGAITV_APPS/$1"
  printf '%s' "$3" >"$ORIGAITV_APPS/$1/manifest.json"
  [[ -f $ORIGAITV_APPS/installed.json ]] || echo '{}' >"$ORIGAITV_APPS/installed.json"
  jq --arg id "$1" --arg tier "$2" '.[$id] = {id: $id, tier: $tier}' "$ORIGAITV_APPS/installed.json" >"$SCRATCH/next" && mv "$SCRATCH/next" "$ORIGAITV_APPS/installed.json"
}
native() {
  printf '{"tv":{"runtime":"native","package":{"%s":"%s"},"exec":["%s"]}}' "$1" "$2" "$2"
}
package() {
  rm -f "$calls"
  "$ROOT/bin/origaitv-app-package" "$1" >"$SCRATCH/out" 2>&1
}

app origaitv.steam official "$(native pacman steam)"
package origaitv.steam || fail "Steam's program installs" "$(cat "$SCRATCH/out")"
[[ $(cat "$calls") == $'omarchy-install-gaming-gpu-lib32 \nomarchy-pkg-add steam' ]] || fail "the lib32 drivers first, then Steam, and nothing that starts it" "$(cat "$calls")"
pass "ADR-042 Steam comes the way Omarchy installs it, with the drivers first and without starting it as root"

app origaitv.game official "$(native pacman stand-in-game)"
package origaitv.game || fail "another program installs" "$(cat "$SCRATCH/out")"
[[ $(cat "$calls") == "omarchy-pkg-add stand-in-game" ]] || fail "with omarchy-pkg-add alone" "$(cat "$calls")"
app origaitv.shell official "$(native pacman bash)"
package origaitv.shell || fail "one that's in already" "$(cat "$SCRATCH/out")"
[[ ! -e $calls ]] || fail "is left as it is" "$(cat "$calls")"
pass "any other program comes with omarchy-pkg-add, and one that's in already is left alone"

# refused <id> <why>: it installs nothing, and says why for the TV.
refused() {
  if package "$1"; then
    fail "$1 is refused" "$(cat "$SCRATCH/out")"
  fi
  [[ ! -e $calls ]] || fail "$1 installs nothing" "$(cat "$calls")"
  [[ $(cat "$ORIGAITV_APP_PACKAGE_ERRORS/$1.error") == "$2" ]] || fail "$1 says why: $2" "$(cat "$ORIGAITV_APP_PACKAGE_ERRORS/$1.error" 2>&1)"
}
app someone.game community "$(native pacman stand-in-game)"
refused someone.game "only an official app installs a program"
app local.game local "$(native pacman stand-in-game)"
refused local.game "only an official app installs a program"
refused origaitv.missing "only an official app installs a program"
app origaitv.web official '{"tv":{"runtime":"web","package":{"pacman":"stand-in-game"}}}'
refused origaitv.web "it isn't a native app"
app origaitv.odd official "$(native pacman '--overwrite=*')"
refused origaitv.odd "'--overwrite=*' isn't a package name"
app origaitv.plex official "$(native flatpak tv.plex.PlexHTPC)"
refused origaitv.plex "Can't install this kind of app yet"
pass "only an official native app names a package, by a package name, and a refusal says why"

# A box that hasn't fetched its package lists yet says to update it first.
rm "$ORIGAITV_PACMAN_SYNC/multilib.db"
app origaitv.later official "$(native pacman later-game)"
refused origaitv.later "Update OrigaiTV in Settings first, then add the app again"
touch "$ORIGAITV_PACMAN_SYNC/multilib.db"
pass "a box without its package lists says to update it, and fetches none on the side"

app origaitv.broken official "$(native pacman broken-game)"
if package origaitv.broken; then
  fail "a program that doesn't install fails"
fi
[[ $(cat "$ORIGAITV_APP_PACKAGE_ERRORS/origaitv.broken.error") == "Couldn't install broken-game" ]] || fail "and says so" "$(cat "$ORIGAITV_APP_PACKAGE_ERRORS/origaitv.broken.error")"
package origaitv.game || fail "a later one"
[[ ! -e $ORIGAITV_APP_PACKAGE_ERRORS/origaitv.game.error ]] || fail "leaves no reason behind when it worked"
pass "a program that doesn't install says so for the TV"

if "$ROOT/bin/origaitv-app-package" "../etc" >/dev/null 2>&1; then
  fail "something that isn't an app id is refused"
fi
grep -qx "ExecStart=/usr/bin/origaitv-app-package %i" "$ROOT/system/origaitv-app-package@.service" || fail "origaitv-app-package@.service runs it for the app named after the @"
grep -qx "RuntimeDirectoryPreserve=yes" "$ROOT/system/origaitv-app-package@.service" || fail "and keeps its reasons for origaitv-setup-apps to read"
pass "origaitv-app-package@.service installs the program for the app named after the @"
