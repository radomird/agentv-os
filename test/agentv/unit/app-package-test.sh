#!/bin/bash

# Guards agentv-app-package (ADR-042): the program an official native app
# opens, installed the way Omarchy's own installer does. For Steam that's
# the lib32 drivers first, then Steam, and never the installer's last step,
# which would start Steam as root. Only an official native app's package,
# by a name that's a package name, and why it didn't, for the TV.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

export AGENTV_APPS="$SCRATCH/apps" AGENTV_APP_PACKAGE_ERRORS="$SCRATCH/errors" OMARCHY_PATH="$SCRATCH/omarchy"
mkdir -p "$AGENTV_APPS" "$OMARCHY_PATH/bin"
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
export AGENTV_PACMAN_SYNC="$SCRATCH/sync"
mkdir -p "$AGENTV_PACMAN_SYNC"
touch "$AGENTV_PACMAN_SYNC/core.db" "$AGENTV_PACMAN_SYNC/extra.db" "$AGENTV_PACMAN_SYNC/multilib.db"

# app <id> <tier> <manifest>: an app where agentv app install puts one.
app() {
  mkdir -p "$AGENTV_APPS/$1"
  printf '%s' "$3" >"$AGENTV_APPS/$1/manifest.json"
  [[ -f $AGENTV_APPS/installed.json ]] || echo '{}' >"$AGENTV_APPS/installed.json"
  jq --arg id "$1" --arg tier "$2" '.[$id] = {id: $id, tier: $tier}' "$AGENTV_APPS/installed.json" >"$SCRATCH/next" && mv "$SCRATCH/next" "$AGENTV_APPS/installed.json"
}
native() {
  printf '{"tv":{"runtime":"native","package":{"%s":"%s"},"exec":["%s"]}}' "$1" "$2" "$2"
}
package() {
  rm -f "$calls"
  "$ROOT/bin/agentv-app-package" "$1" >"$SCRATCH/out" 2>&1
}

app agentv.steam official "$(native pacman steam)"
package agentv.steam || fail "Steam's program installs" "$(cat "$SCRATCH/out")"
[[ $(cat "$calls") == $'omarchy-install-gaming-gpu-lib32 \nomarchy-pkg-add steam' ]] || fail "the lib32 drivers first, then Steam, and nothing that starts it" "$(cat "$calls")"
pass "ADR-042 Steam comes the way Omarchy installs it, with the drivers first and without starting it as root"

app agentv.game official "$(native pacman stand-in-game)"
package agentv.game || fail "another program installs" "$(cat "$SCRATCH/out")"
[[ $(cat "$calls") == "omarchy-pkg-add stand-in-game" ]] || fail "with omarchy-pkg-add alone" "$(cat "$calls")"
app agentv.shell official "$(native pacman bash)"
package agentv.shell || fail "one that's in already" "$(cat "$SCRATCH/out")"
[[ ! -e $calls ]] || fail "is left as it is" "$(cat "$calls")"
pass "any other program comes with omarchy-pkg-add, and one that's in already is left alone"

# refused <id> <why>: it installs nothing, and says why for the TV.
refused() {
  if package "$1"; then
    fail "$1 is refused" "$(cat "$SCRATCH/out")"
  fi
  [[ ! -e $calls ]] || fail "$1 installs nothing" "$(cat "$calls")"
  [[ $(cat "$AGENTV_APP_PACKAGE_ERRORS/$1.error") == "$2" ]] || fail "$1 says why: $2" "$(cat "$AGENTV_APP_PACKAGE_ERRORS/$1.error" 2>&1)"
}
app someone.game community "$(native pacman stand-in-game)"
refused someone.game "only an official app installs a program"
app local.game local "$(native pacman stand-in-game)"
refused local.game "only an official app installs a program"
refused agentv.missing "only an official app installs a program"
app agentv.web official '{"tv":{"runtime":"web","package":{"pacman":"stand-in-game"}}}'
refused agentv.web "it isn't a native app"
app agentv.odd official "$(native pacman '--overwrite=*')"
refused agentv.odd "'--overwrite=*' isn't a package name"
app agentv.plex official "$(native flatpak tv.plex.PlexHTPC)"
refused agentv.plex "a flatpak program isn't installed from the tv yet"
pass "only an official native app names a package, by a package name, and a refusal says why"

# A box that hasn't fetched its package lists yet says to update it first.
rm "$AGENTV_PACMAN_SYNC/multilib.db"
app agentv.later official "$(native pacman later-game)"
refused agentv.later "the box doesn't have its package lists yet: update it from settings, then add the app again"
touch "$AGENTV_PACMAN_SYNC/multilib.db"
pass "a box without its package lists says to update it, and fetches none on the side"

app agentv.broken official "$(native pacman broken-game)"
if package agentv.broken; then
  fail "a program that doesn't install fails"
fi
[[ $(cat "$AGENTV_APP_PACKAGE_ERRORS/agentv.broken.error") == "broken-game didn't install" ]] || fail "and says so" "$(cat "$AGENTV_APP_PACKAGE_ERRORS/agentv.broken.error")"
package agentv.game || fail "a later one"
[[ ! -e $AGENTV_APP_PACKAGE_ERRORS/agentv.game.error ]] || fail "leaves no reason behind when it worked"
pass "a program that doesn't install says so for the TV"

if "$ROOT/bin/agentv-app-package" "../etc" >/dev/null 2>&1; then
  fail "something that isn't an app id is refused"
fi
grep -qx "ExecStart=/usr/bin/agentv-app-package %i" "$ROOT/system/agentv-app-package@.service" || fail "agentv-app-package@.service runs it for the app named after the @"
grep -qx "RuntimeDirectoryPreserve=yes" "$ROOT/system/agentv-app-package@.service" || fail "and keeps its reasons for agentv-setup-apps to read"
pass "agentv-app-package@.service installs the program for the app named after the @"
