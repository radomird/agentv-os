#!/bin/bash

# Guards the game platforms' own steps (ADR-103), which Omarchy's installers
# do at a terminal: origaitv-game-setup, RetroArch's settings and ~/Games and
# Battle.net's setup, in the person's home; origaitv-battlenet, which runs
# Battle.net's setup the first time its tile opens and Omarchy's launcher
# after that; and origaitv-xbox-driver, the driver for Xbox controllers,
# without a question or a restart.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

calls="$SCRATCH/calls"
mkdir -p "$SCRATCH/bin" "$SCRATCH/home" "$SCRATCH/omarchy/bin" "$SCRATCH/omarchy/default/applications"
export HOME="$SCRATCH/home" OMARCHY_PATH="$SCRATCH/omarchy" ORIGAITV_BATTLENET_SETUP_URL="https://example.invalid/setup"
# curl writes the file it's asked for, unless the download is down.
cat >"$SCRATCH/bin/curl" <<STUB
#!/bin/bash
echo "curl \$*" >>"$calls"
[[ ! -e $SCRATCH/offline ]] || exit 22
while (( \$# )); do
  [[ \$1 == --output ]] && { echo setup >"\$2"; exit 0; }
  shift
done
STUB
for name in update-desktop-database umu-run; do
  cat >"$SCRATCH/bin/$name" <<STUB
#!/bin/bash
echo "$name \$* WINEPREFIX=\${WINEPREFIX:-} PROTONPATH=\${PROTONPATH:-} GAMEID=\${GAMEID:-}" >>"$calls"
[[ $name != umu-run || ! -e $SCRATCH/setup-installs ]] || { mkdir -p "\$WINEPREFIX/drive_c/Program Files (x86)/Battle.net"; touch "\$WINEPREFIX/drive_c/Program Files (x86)/Battle.net/Battle.net Launcher.exe"; }
STUB
done
cat >"$OMARCHY_PATH/bin/omarchy-launch-battlenet" <<STUB
#!/bin/bash
echo "omarchy-launch-battlenet" >>"$calls"
STUB
printf '%s\n' '[Desktop Entry]' 'Name=Battle.net' 'Exec=omarchy-launch-battlenet' >"$OMARCHY_PATH/default/applications/battlenet.desktop"
chmod +x "$SCRATCH/bin/"* "$OMARCHY_PATH/bin/"*
export PATH="$SCRATCH/bin:$PATH"

# --- RetroArch ---------------------------------------------------------------

cfg="$HOME/.config/retroarch/retroarch.cfg"
mkdir -p "$(dirname -- "$cfg")"
printf '%s\n' 'video_driver = "gl"' 'audio_volume = "-3.0"' >"$cfg"
"$ROOT/bin/origaitv-game-setup" retroarch >"$SCRATCH/out" 2>&1 || fail "RetroArch's first steps run" "$(cat "$SCRATCH/out")"
[[ -d $HOME/Games/bios && -d $HOME/Games/roms ]] || fail "Games has a folder for BIOS files and one for games"
grep -qx "rgui_browser_directory = \"$HOME/Games/roms\"" "$cfg" || fail "RetroArch looks for games in ~/Games/roms" "$(cat "$cfg")"
grep -qx "system_directory = \"$HOME/Games/bios\"" "$cfg" || fail "and BIOS files in ~/Games/bios"
grep -qx 'libretro_directory = "/usr/lib/libretro"' "$cfg" || fail "and its cores where pacman put them"
if ! grep -qx 'video_driver = "vulkan"' "$cfg" || ! grep -qx 'menu_driver = "xmb"' "$cfg"; then
  fail "with Vulkan and the XMB menu, as Omarchy picks them" "$(cat "$cfg")"
fi
grep -qx 'audio_volume = "-3.0"' "$cfg" || fail "and leaves what it doesn't set as it was"
grep -q "crt-royale.slangp" "$HOME/.config/retroarch/config/global.slangp" || fail "and the CRT look"
"$ROOT/bin/origaitv-game-setup" retroarch >"$SCRATCH/out" 2>&1 || fail "a second time" "$(cat "$SCRATCH/out")"
[[ $(grep -c '^video_driver = ' "$cfg") == 1 ]] || fail "a second run keeps one line for each setting" "$(cat "$cfg")"
! grep -rq "nautilus" "$ROOT/bin/origaitv-game-setup" || fail "and nothing opens a file manager on the TV"
pass "ADR-103 RetroArch's settings and ~/Games, as Omarchy's installer makes them, and again with nothing doubled"

# --- Battle.net ----------------------------------------------------------------

rm -f "$calls"
"$ROOT/bin/origaitv-game-setup" battlenet >"$SCRATCH/out" 2>&1 || fail "Battle.net's first steps run" "$(cat "$SCRATCH/out")"
[[ -d $HOME/Games/battlenet ]] || fail "its folder is there"
[[ -f $HOME/.local/share/applications/battlenet.desktop ]] || fail "and its entry in Omarchy's app launcher"
[[ $(cat "$HOME/.cache/origaitv/Battle.net-Setup.exe") == setup ]] || fail "and its setup, downloaded" "$(cat "$calls")"
grep -q "curl .* https://example.invalid/setup$" "$calls" || fail "from Blizzard's own address" "$(cat "$calls")"
rm -f "$calls"
"$ROOT/bin/origaitv-game-setup" battlenet >"$SCRATCH/out" 2>&1 || fail "a second time" "$(cat "$SCRATCH/out")"
! grep -q "^curl" "$calls" || fail "doesn't download it again" "$(cat "$calls")"
rm "$HOME/.cache/origaitv/Battle.net-Setup.exe"
touch "$SCRATCH/offline"
if "$ROOT/bin/origaitv-game-setup" battlenet >"$SCRATCH/out" 2>&1; then
  fail "a download that fails fails the step"
fi
[[ ! -e $HOME/.cache/origaitv/Battle.net-Setup.exe ]] || fail "and leaves no setup behind"
rm "$SCRATCH/offline"
pass "ADR-103 Battle.net's folder, its launcher entry and its setup, downloaded once, and a download that fails says so"

# The tile: the setup the first time, in the prefix, then Battle.net itself.
rm -f "$calls"
"$ROOT/bin/origaitv-game-setup" battlenet >/dev/null 2>&1
rm -f "$calls"
touch "$SCRATCH/setup-installs"
"$ROOT/bin/origaitv-battlenet" >"$SCRATCH/out" 2>&1 || fail "the first open runs the setup" "$(cat "$SCRATCH/out")"
[[ $(head -n 1 "$calls") == "umu-run $HOME/.cache/origaitv/Battle.net-Setup.exe WINEPREFIX=$HOME/Games/battlenet PROTONPATH=GE-Proton GAMEID=umu-battlenet" ]] || fail "in Battle.net's own prefix, under GE-Proton" "$(cat "$calls")"
[[ $(tail -n 1 "$calls") == "omarchy-launch-battlenet" ]] || fail "then opens Battle.net with Omarchy's launcher" "$(cat "$calls")"
rm -f "$calls"
"$ROOT/bin/origaitv-battlenet" >"$SCRATCH/out" 2>&1 || fail "a later open" "$(cat "$SCRATCH/out")"
[[ $(cat "$calls") == "omarchy-launch-battlenet" ]] || fail "opens Battle.net straight away" "$(cat "$calls")"
[[ ! -e $HOME/.cache/origaitv/battlenet-setup.unfinished ]] || fail "a setup that finished leaves no marker"
# A prefix without Battle.net where the setup puts it, and no unfinished
# setup of ours: it's left as it is, and the setup runs in it.
rm -rf "$HOME/Games/battlenet"
mkdir -p "$HOME/Games/battlenet/drive_c/elsewhere"
rm "$SCRATCH/setup-installs"
rm -f "$calls"
if "$ROOT/bin/origaitv-battlenet" >"$SCRATCH/out" 2>&1; then
  fail "a setup that ends with no Battle.net fails"
fi
[[ -d $HOME/Games/battlenet/drive_c/elsewhere ]] || fail "a prefix it didn't leave half-made stays where it is" "$(ls "$HOME/Games")"
! compgen -G "$HOME/Games/battlenet.unfinished-*" >/dev/null || fail "and nothing is set aside" "$(ls "$HOME/Games")"
[[ -e $HOME/.cache/origaitv/battlenet-setup.unfinished ]] || fail "a setup that ended before Battle.net was in is marked"
# The next open, after that setup was closed halfway: its prefix is set
# aside, never deleted, and the setup runs again.
rm -f "$calls"
"$ROOT/bin/origaitv-battlenet" >"$SCRATCH/out" 2>&1 && fail "a setup that ends with no Battle.net fails again"
compgen -G "$HOME/Games/battlenet.unfinished-*/drive_c" >/dev/null || fail "the half-made prefix is set aside" "$(ls "$HOME/Games")"
grep -q "^umu-run " "$calls" || fail "and the setup runs again" "$(cat "$calls")"
pass "ADR-103 Battle.net's tile runs its setup the first time, then Battle.net, sets aside only a prefix its own setup left half-made, and never deletes one"

# --- The Xbox controller driver --------------------------------------------------

export ORIGAITV_ETC="$SCRATCH/etc" ORIGAITV_APP_PACKAGE_ERRORS="$SCRATCH/errors" ORIGAITV_PACMAN_SYNC="$SCRATCH/sync"
mkdir -p "$ORIGAITV_PACMAN_SYNC"
touch "$ORIGAITV_PACMAN_SYNC/core.db"
for name in omarchy-pkg-add modprobe lsmod pacman pacman-conf; do
  cat >"$OMARCHY_PATH/bin/$name" <<STUB
#!/bin/bash
echo "$name \$*" >>"$calls"
case $name in
  pacman) [[ -e $SCRATCH/has-driver ]] ;;
  pacman-conf) echo core ;;
  lsmod) [[ -e $SCRATCH/xpad-loaded ]] && echo "xpad 45056 0" ;;
  modprobe) [[ \$1 != -r || ! -e $SCRATCH/xpad-busy ]] ;;
  omarchy-pkg-add) [[ ! -e $SCRATCH/no-driver ]] ;;
esac
STUB
done
chmod +x "$OMARCHY_PATH/bin/"*
driver() {
  rm -f "$calls"
  "$ROOT/bin/origaitv-xbox-driver" >"$SCRATCH/out" 2>&1
}
touch "$SCRATCH/xpad-loaded"
driver || fail "the driver installs" "$(cat "$SCRATCH/out")"
grep -qx "omarchy-pkg-add xpadneo-dkms" "$calls" || fail "xpadneo, from the box's repositories" "$(cat "$calls")"
[[ $(cat "$ORIGAITV_ETC/modprobe.d/blacklist-xpad.conf") == "blacklist xpad" ]] || fail "the old driver kept from loading"
[[ $(cat "$ORIGAITV_ETC/modules-load.d/xpadneo.conf") == "hid_xpadneo" ]] || fail "and xpadneo loaded at boot"
if ! grep -qx "modprobe -r xpad" "$calls" || ! grep -qx "modprobe hid_xpadneo" "$calls"; then
  fail "swapped in now" "$(cat "$calls")"
fi
[[ ! -e $ORIGAITV_APP_PACKAGE_ERRORS/xpadneo.restart ]] || fail "with no restart"
! grep -q "usermod\|reboot\|gum" "$ROOT/bin/origaitv-xbox-driver" || fail "and no question, no restart and no input group"
touch "$SCRATCH/has-driver" "$SCRATCH/xpad-busy"
driver || fail "with the old driver busy" "$(cat "$SCRATCH/out")"
! grep -q "omarchy-pkg-add" "$calls" || fail "it doesn't install what's there" "$(cat "$calls")"
[[ -e $ORIGAITV_APP_PACKAGE_ERRORS/xpadneo.restart ]] || fail "and says a restart finishes it"
rm -f "$SCRATCH/has-driver" "$SCRATCH/xpad-busy"
touch "$SCRATCH/no-driver"
if driver; then fail "a driver that doesn't install fails"; fi
[[ $(cat "$ORIGAITV_APP_PACKAGE_ERRORS/xpadneo.error") == "Couldn't install the driver. Try again later." ]] || fail "and says why" "$(cat "$ORIGAITV_APP_PACKAGE_ERRORS/xpadneo.error" 2>&1)"
pass "ADR-103 the Xbox controller driver installs and swaps in without a question, or says a restart finishes it"
