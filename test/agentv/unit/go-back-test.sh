#!/bin/bash

# Guards Go back after an update (ADR-025, S2.14): agentv-update-after, the
# check after an update, which writes what it found for the TV's "something's
# off" screen; and agentv-go-back, which makes a writable copy of the
# snapshot from before the update the root at the next boot, with the boot
# menu rebuilt from it, and restarts. btrfs, the mounts and the boot menu are
# stand-ins here; the image layer goes back for real.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

export AGENTV_UPDATE_STATE="$SCRATCH/update" AGENTV_CHROMIUM_STATE="$SCRATCH/chromium" CALLS="$SCRATCH/calls"
mkdir -p "$AGENTV_UPDATE_STATE" "$SCRATCH/bin"
: >"$CALLS"

# The daemon, as curl reaches it.
cat >"$SCRATCH/bin/curl" <<'SH'
#!/bin/bash
url=${*: -1}
[[ ${FAKE_DAEMON:-up} == "up" ]] || exit 7
case "$url" in
  */health) echo "{\"ok\":true,\"running\":\"${FAKE_RUNNING:-0.3.0-1}\"}" ;;
  */launcher/main.ts) echo 'export {};' ;;
  */api/home) echo '{"ok":true}' ;;
  */api/apps/check) echo "${FAKE_APPS:-{\"ok\":true,\"apps\":[]}}" ;;
  *) exit 22 ;;
esac
SH
cat >"$SCRATCH/bin/pacman" <<'SH'
#!/bin/bash
[[ $1 == "-Q" ]] || exit 1
case "$2" in
  agentv) echo "agentv ${FAKE_AGENTV:-0.3.0-1}" ;;
  omarchy) echo "omarchy 4.0.6-1" ;;
  *) exit 1 ;;
esac
SH
cat >"$SCRATCH/bin/chromium" <<'SH'
#!/bin/bash
exit "${FAKE_CHROMIUM:-0}"
SH
chmod +x "$SCRATCH/bin/"*
export PATH="$SCRATCH/bin:$PATH"

after="$AGENTV_UPDATE_STATE/after.json"
check_after() {
  "$ROOT/bin/agentv-update-after" >"$SCRATCH/after.out" 2>&1
}

# --- The check after an update -----------------------------------------------

touch "$AGENTV_UPDATE_STATE/check-pending"
check_after || fail "the check passes on a box that's fine" "$(cat "$SCRATCH/after.out")"
[[ $(jq -c '[.ok, .agentv, [.checks[].name]]' "$after") == '[true,"0.3.0-1",["daemon","home screen","chromium and widevine"]]' ]] ||
  fail "S2.14 the check looks at the daemon, the home screen and Chromium" "$(cat "$after")"
[[ ! -f $AGENTV_UPDATE_STATE/check-pending ]] || fail "the check after a restart runs once"
[[ $(stat -c %a "$after") == 644 ]] || fail "the home screen's daemon can read what the check found"
pass "S2.14 the check after an update looks at the daemon, the home screen and Chromium"

FAKE_APPS='{"ok":true,"apps":[{"id":"agentv.tube","name":"Tube","ok":true},{"id":"someone.jellyfin","name":"Jellyfin","ok":false,"error":"Jellyfin couldn'"'"'t load"}]}' \
  check_after && fail "the check fails when an app won't load"
[[ $(jq -c '[.ok, [.checks[] | select(.ok | not) | .detail], [.checks[] | select(.ok) | .name]]' "$after") == '[false,["Jellyfin won'"'"'t load"],["daemon","home screen","chromium and widevine","Tube"]]' ]] ||
  fail "S2.14 an app that won't load is named" "$(cat "$after")"
pass "S2.14 every installed app is checked, and one that won't load is named"

# Widevine: a box that never had it hasn't lost it.
echo '{"widevine": true}' >"$AGENTV_UPDATE_STATE/go-back.json"
check_after && fail "the check fails when Widevine is gone"
[[ $(jq -r '.checks[] | select(.name == "chromium and widevine") | .detail' "$after") == "chromium has lost widevine" ]] ||
  fail "Widevine that was there before the update and isn't now" "$(cat "$after")"
mkdir -p "$AGENTV_CHROMIUM_STATE/WidevineCdm/4.10"
echo '{}' >"$AGENTV_CHROMIUM_STATE/WidevineCdm/4.10/manifest.json"
check_after || fail "Widevine still there passes" "$(cat "$after")"
FAKE_CHROMIUM=1 check_after && fail "the check fails when Chromium doesn't start"
[[ $(jq -r '.checks[] | select(.name == "chromium and widevine") | .detail' "$after") == "chromium doesn't start" ]] ||
  fail "Chromium that doesn't start" "$(cat "$after")"
pass "the check fails when Chromium doesn't start, or lost the Widevine it had"

# The update restarts AgenTV's services, so the daemon runs the new version.
FAKE_RUNNING=0.2.1-1 AGENTV_AFTER_WAIT=0 check_after && fail "the check fails when the daemon still runs the old version"
[[ $(jq -r '.checks[] | select(.name == "daemon") | .detail' "$after") == "the daemon still runs agentv 0.2.1-1" ]] ||
  fail "a daemon still on the version from before the update" "$(cat "$after")"
pass "the check fails when the daemon still runs the version from before the update"

FAKE_DAEMON=down AGENTV_AFTER_WAIT=0 check_after && fail "the check fails when the daemon is down"
[[ $(jq -c '[.checks[] | select(.ok | not) | .name]' "$after") == '["daemon","home screen"]' ]] ||
  fail "a daemon that doesn't answer, and so no home screen" "$(cat "$after")"
pass "the check fails when the daemon doesn't answer"

# --- Going back ----------------------------------------------------------------

top="$SCRATCH/top"
snapshots="$SCRATCH/snapshots"
export AGENTV_GO_BACK_TOP="$top" AGENTV_SNAPSHOTS="$snapshots"

cat >"$SCRATCH/bin/findmnt" <<'SH'
#!/bin/bash
case "$*" in
  "-no SOURCE /") echo "/dev/vda2[/@]" ;;
  "-no FSTYPE /") echo "${FAKE_FS:-btrfs}" ;;
  "-no OPTIONS /") echo "rw,relatime,compress=zstd:3,ssd,subvolid=256,subvol=/@" ;;
esac
SH
cat >"$SCRATCH/bin/btrfs" <<'SH'
#!/bin/bash
echo "btrfs $*" >>"$CALLS"
case "$1 $2" in
  "subvolume show") [[ -d $3 ]] ;;
  "subvolume snapshot") cp -a "$3" "$4" ;;
  "subvolume delete") shift 2; [[ $1 == "--recursive" ]] && shift; rm -rf "$1" ;;
  *) exit 1 ;;
esac
SH
for name in mount umount systemctl; do
  cat >"$SCRATCH/bin/$name" <<SH
#!/bin/bash
echo "$name \$*" >>"\$CALLS"
SH
done
cat >"$SCRATCH/bin/chroot" <<'SH'
#!/bin/bash
echo "chroot $*" >>"$CALLS"
exit "${FAKE_LIMINE:-0}"
SH
printf '#!/bin/bash\nexit 1\n' >"$SCRATCH/bin/mountpoint"
printf '#!/bin/bash\n' >"$SCRATCH/bin/sleep"
printf '#!/bin/bash\n' >"$SCRATCH/bin/sync"
chmod +x "$SCRATCH/bin/"*

# The disk: the running root, and the snapshot from before the update, each
# with what it says about itself.
setup_disk() {
  rm -rf "$top" "$snapshots"
  mkdir -p "$top/@/var/lib/agentv/update" "$snapshots/7/snapshot/etc" "$snapshots/7/snapshot/var/lib/agentv/update"
  echo "after the update" >"$top/@/marker"
  echo "before the update" >"$snapshots/7/snapshot/marker"
  echo "UUID=ABCD-1234 /boot vfat rw 0 2" >"$snapshots/7/snapshot/etc/fstab"
  echo '{"snapshot": 2}' >"$snapshots/7/snapshot/var/lib/agentv/update/go-back.json"
  cat >"$AGENTV_UPDATE_STATE/go-back.json" <<'JSON'
{"snapshot": 7, "widevine": false, "at": "2026-10-23T22:00:00Z",
 "from": {"agentv": "0.2.1-1", "omarchy": "4.0.6-1"}, "to": {"agentv": "0.3.0-1", "omarchy": "4.0.6-1"}}
JSON
  rm -f "$AGENTV_UPDATE_STATE/progress.json"
  : >"$CALLS"
}
go_back() {
  "$ROOT/bin/agentv-go-back" "$@" >"$SCRATCH/go-back.out" 2>&1
}
progress="$AGENTV_UPDATE_STATE/progress.json"

setup_disk
go_back || fail "going back goes through" "$(cat "$SCRATCH/go-back.out")"
[[ $(cat "$top/@/marker") == "before the update" ]] || fail "S2.14 the snapshot from before the update is the root at the next boot"
old=$(find "$top" -maxdepth 1 -name '@agentv-old-*' | head -n 1)
[[ -n $old && $(cat "$old/marker") == "after the update" ]] || fail "the system it replaced is kept until the next boot" "$(ls -a "$top")"
[[ -f $snapshots/7/snapshot/marker ]] || fail "the snapshot itself stays as it was"
grep -q "^btrfs subvolume snapshot $snapshots/7/snapshot $top/@agentv-next$" "$CALLS" || fail "the root is a writable copy of the snapshot" "$(cat "$CALLS")"
grep -q "^mount -o subvolid=5 /dev/vda2 $top$" "$CALLS" || fail "it works from the top of the disk" "$(cat "$CALLS")"
grep -q "^chroot $top/@agentv-next /usr/bin/limine-update$" "$CALLS" || fail "the boot menu is rebuilt from inside the copy" "$(cat "$CALLS")"
grep -q "^mount --bind /boot $top/@agentv-next/boot$" "$CALLS" || fail "with the boot partition the copy's fstab names" "$(cat "$CALLS")"
grep -q "^systemctl mask --runtime --now limine-snapper-sync.service limine-snapper-sync.path$" "$CALLS" || fail "limine-snapper-sync waits"
[[ $(tail -n 1 "$CALLS") == "systemctl reboot" ]] || fail "S2.14 the box restarts into it, last" "$(cat "$CALLS")"
went="$top/@/var/lib/agentv/update"
[[ $(jq -c '[.from.agentv, .to.agentv]' "$went/went-back.json") == '["0.3.0-1","0.2.1-1"]' ]] || fail "the TV hears it went back, and from where" "$(cat "$went/went-back.json")"
[[ -f $went/cleanup-pending && ! -f $went/go-back.json ]] || fail "the old system goes at the next boot, and there's no going back again from there"
[[ $(jq -c '[.state, .what, .percent, .to.agentv]' "$progress") == '["going-back","go-back",98,"0.2.1-1"]' ]] || fail "the TV says it's going back" "$(cat "$progress")"
pass "S2.14 Go back makes the snapshot from before the update the root, rebuilds the boot menu from it, and restarts"

# The next boot deletes the system it replaced.
touch "$AGENTV_UPDATE_STATE/cleanup-pending"
go_back --cleanup || fail "the cleanup goes through" "$(cat "$SCRATCH/go-back.out")"
[[ -z $(find "$top" -maxdepth 1 -name '@agentv-old-*') ]] || fail "the cleanup deletes the old system" "$(ls -a "$top")"
[[ ! -f $AGENTV_UPDATE_STATE/cleanup-pending && -d $top/@ ]] || fail "and only that, once"
pass "the boot after going back deletes the system it replaced"

# What stops it, with the box as it was.
refused() {
  [[ $(cat "$top/@/marker") == "after the update" ]] || fail "$1: the root stays" "$(cat "$top/@/marker")"
  ! grep -q "reboot" "$CALLS" || fail "$1: no restart"
  [[ $(jq -c '[.state, .detail]' "$progress") == "[\"failed\",\"$2\"]" ]] || fail "$1: the TV says why" "$(cat "$progress")"
}
setup_disk
FAKE_AGENTV=0.3.1-1 go_back && fail "a box updated again since can't go back"
refused "updated again since" "the box has been updated again since"
setup_disk
rm -rf "$snapshots/7"
go_back && fail "a snapshot that's gone can't be gone back to"
refused "the snapshot is gone" "the snapshot from before the update is gone"
setup_disk
FAKE_LIMINE=1 go_back && fail "a boot menu that won't rebuild stops it"
refused "the boot menu won't rebuild" "couldn't rebuild the boot menu"
setup_disk
FAKE_FS=ext4 go_back && fail "a disk not laid out as Omarchy's stops it"
refused "not Omarchy's layout" "this box's disk isn't laid out the way Omarchy installs it"
setup_disk
rm "$AGENTV_UPDATE_STATE/go-back.json"
go_back && fail "with no update from the TV there's nothing to go back from"
refused "no update" "there's no update to go back from"
pass "Go back stops, with the box as it was, when the box changed since, the snapshot is gone, or the boot menu won't rebuild"
