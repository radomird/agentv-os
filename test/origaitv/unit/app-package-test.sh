#!/bin/bash

# Guards origaitv-app-package (ADR-042): the program an official native app
# opens, installed the way Omarchy's own installer does. For Steam that's
# the lib32 drivers first, then Steam, and never the installer's last step,
# which would start Steam as root. Only an official native app's package,
# by a name that's a package name, and why it didn't, for the TV. Then every
# game platform Omarchy's menu has (ADR-103): each one's packages, GeForce
# NOW's flatpak from NVIDIA's own repository, and the first steps that run
# as the person, with no sudo.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

export ORIGAITV_APPS="$SCRATCH/apps" ORIGAITV_APP_PACKAGE_ERRORS="$SCRATCH/errors" OMARCHY_PATH="$SCRATCH/omarchy"
mkdir -p "$ORIGAITV_APPS" "$OMARCHY_PATH/bin"
calls="$SCRATCH/calls"

# Stand-ins for Omarchy's commands and pacman, which note each call. pacman
# knows only the packages in $SCRATCH/installed.
for name in omarchy-pkg-add omarchy-install-gaming-gpu-lib32 omarchy-install-gaming-steam uwsm-app gtk-launch flatpak; do
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
app origaitv.flat official "$(native flatpak org.example.Game)"
refused origaitv.flat "Can't install this kind of app yet"
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

# --- Every game platform (ADR-103) -------------------------------------------

# The person's steps run as the person: a stand-in for runuser notes who and
# with what, then runs the step's own stand-in, which notes its argument.
export ORIGAITV_OWNER=tv ORIGAITV_RUNUSER="$SCRATCH/runuser"
cat >"$ORIGAITV_RUNUSER" <<STUB
#!/bin/bash
echo "runuser \$1 \$2 \$3 \$*" >>"$calls"
shift 3
[[ \$1 == env ]] && shift
for arg; do
  case \$arg in
    HOME=*|USER=*|LOGNAME=*|SHELL=*|PATH=*|OMARCHY_PATH=*|LANG=*) shift ;;
    -i) shift ;;
    *) break ;;
  esac
done
echo "as \$(printf '%s ' "\$@")" >>"$calls"
[[ \${!#} != battlenet || ! -e $SCRATCH/no-download ]]
STUB
chmod +x "$ORIGAITV_RUNUSER"
# getent knows the person and their home.
cat >"$OMARCHY_PATH/bin/getent" <<STUB
#!/bin/bash
[[ \$1 == passwd && \$2 == tv ]] && echo "tv:x:1000:1000::$SCRATCH:/bin/bash"
STUB
chmod +x "$OMARCHY_PATH/bin/getent"

app origaitv.retroarch official "$(native pacman retroarch)"
package origaitv.retroarch || fail "RetroArch installs" "$(cat "$SCRATCH/out")"
grep -q "^omarchy-pkg-add retroarch retroarch-assets-glui .* libretro-snes9x .* retroarch-joypad-autoconfig-git$" "$calls" || fail "with its menus and every core, as Omarchy's installer has them" "$(cat "$calls")"
! grep -q "gpu-lib32" "$calls" || fail "and no lib32 drivers it doesn't need" "$(cat "$calls")"
grep -q "^runuser -u tv -- .*HOME=$SCRATCH .*bash --noprofile --norc $ROOT/bin/origaitv-game-setup retroarch$" "$calls" || fail "then its settings and ~/Games, as the person, in a clean shell" "$(cat "$calls")"
! grep -q "sudo" "$calls" || fail "with no sudo" "$(cat "$calls")"
pass "ADR-103 RetroArch comes with every core, and its first steps run as the person"

printf '%s\n' retroarch retroarch-assets-glui >>"$SCRATCH/installed"
package origaitv.retroarch || fail "RetroArch again" "$(cat "$SCRATCH/out")"
grep -q "^omarchy-pkg-add retroarch-assets-ozone " "$calls" || fail "installs only what's missing" "$(cat "$calls")"
grep -q "origaitv-game-setup retroarch$" "$calls" || fail "and its first steps run again" "$(cat "$calls")"
pass "a platform that's partly there gets what's missing, and its first steps again"

app origaitv.lutris official "$(native pacman lutris)"
export ORIGAITV_LUTRIS="$SCRATCH/lutris"
printf '%s\n' '#!/usr/bin/env python3' 'import lutris' >"$ORIGAITV_LUTRIS"
package origaitv.lutris || fail "Lutris installs" "$(cat "$SCRATCH/out")"
[[ $(cat "$calls") == $'omarchy-install-gaming-gpu-lib32 \nomarchy-pkg-add lutris umu-launcher wine-staging wine-mono wine-gecko winetricks python-protobuf' ]] || fail "with the lib32 drivers first, then Wine and umu-launcher" "$(cat "$calls")"
[[ $(head -n 1 "$ORIGAITV_LUTRIS") == "#!/bin/python3" ]] || fail "and the system's Python, as Omarchy's fix has it" "$(cat "$ORIGAITV_LUTRIS")"
pass "ADR-103 Lutris comes with Wine, and runs on the system's Python"

app origaitv.heroic official "$(native pacman heroic-games-launcher-bin)"
package origaitv.heroic || fail "Heroic installs" "$(cat "$SCRATCH/out")"
[[ $(cat "$calls") == $'omarchy-install-gaming-gpu-lib32 \nomarchy-pkg-add heroic-games-launcher-bin' ]] || fail "with the lib32 drivers first" "$(cat "$calls")"
app origaitv.minecraft official "$(native pacman minecraft-launcher)"
package origaitv.minecraft || fail "Minecraft installs" "$(cat "$SCRATCH/out")"
[[ $(cat "$calls") == "omarchy-pkg-add minecraft-launcher" ]] || fail "with its launcher alone" "$(cat "$calls")"
echo moonlight-qt >>"$SCRATCH/installed"
app origaitv.moonlight official "$(native pacman moonlight-qt)"
package origaitv.moonlight || fail "Moonlight, which every TV has" "$(cat "$SCRATCH/out")"
[[ ! -e $calls ]] || fail "needs nothing" "$(cat "$calls")"
pass "ADR-103 Heroic, Minecraft and Moonlight come the way Omarchy installs them, and Moonlight's there already"

app origaitv.battlenet official '{"tv":{"runtime":"native","package":{"pacman":"umu-launcher"},"exec":["origaitv-battlenet"]}}'
package origaitv.battlenet || fail "Battle.net installs" "$(cat "$SCRATCH/out")"
[[ $(head -n 2 "$calls") == $'omarchy-install-gaming-gpu-lib32 \nomarchy-pkg-add umu-launcher' ]] || fail "umu-launcher, with the lib32 drivers first" "$(cat "$calls")"
grep -q "origaitv-game-setup battlenet$" "$calls" || fail "then its folder and setup, as the person" "$(cat "$calls")"
echo umu-launcher >>"$SCRATCH/installed"
touch "$SCRATCH/no-download"
refused_after() {
  if package "$1"; then fail "$1 fails" "$(cat "$SCRATCH/out")"; fi
  [[ $(cat "$ORIGAITV_APP_PACKAGE_ERRORS/$1.error") == "$2" ]] || fail "$1 says why: $2" "$(cat "$ORIGAITV_APP_PACKAGE_ERRORS/$1.error" 2>&1)"
}
refused_after origaitv.battlenet "Couldn't download Battle.net's setup. Try again later."
rm "$SCRATCH/no-download"
pass "ADR-103 Battle.net gets umu-launcher, then its setup downloaded as the person, and says when it couldn't"

# GeForce NOW: flatpak, with Flathub and NVIDIA's own repository. flatpak
# knows only the apps in $SCRATCH/flatpaks.
cat >"$OMARCHY_PATH/bin/flatpak" <<STUB
#!/bin/bash
echo "flatpak \$*" >>"$calls"
[[ \$1 != info ]] || grep -qx -- "\${!#}" "$SCRATCH/flatpaks" 2>/dev/null
STUB
chmod +x "$OMARCHY_PATH/bin/flatpak"
app origaitv.geforcenow official "$(native flatpak com.nvidia.geforcenow)"
package origaitv.geforcenow || fail "GeForce NOW installs" "$(cat "$SCRATCH/out")"
expected=$'flatpak info --system -- com.nvidia.geforcenow\nomarchy-pkg-add flatpak\nflatpak remote-add --system --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo\nflatpak remote-add --system --if-not-exists GeForceNOW https://international.download.nvidia.com/GFNLinux/flatpak/geforcenow.flatpakrepo\nflatpak install --system --noninteractive -y GeForceNOW com.nvidia.geforcenow'
[[ $(cat "$calls") == "$expected" ]] || fail "Flatpak, Flathub and NVIDIA's repository, for the whole box, with no questions" "$(cat "$calls")"
pass "ADR-103 GeForce NOW's flatpak comes from NVIDIA's own repository, with Flathub for its runtime"
echo com.nvidia.geforcenow >"$SCRATCH/flatpaks"
package origaitv.geforcenow || fail "GeForce NOW again" "$(cat "$SCRATCH/out")"
[[ $(cat "$calls") == "flatpak info --system -- com.nvidia.geforcenow" ]] || fail "is left as it is once it's there" "$(cat "$calls")"
pass "and one that's there already is left as it is"
