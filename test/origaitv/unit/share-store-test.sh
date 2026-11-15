#!/bin/bash

# Guards origaitv-share-store (ADR-038): a NAS share's password, handed over by
# Music, is kept root's alone and the share mounts read-only, owned by the
# person who added it; a password the NAS turns down says so and isn't kept;
# the shares mount again as the box starts; forgetting a share takes its
# password too; only a plain file of an ordinary user's counts; and no
# password is in anything but its credentials file. mount, umount,
# mountpoint and getent are stand-ins.

# shellcheck disable=SC2016 # the fakes' bodies are run later, by the script under test
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

export ORIGAITV_ETC="$SCRATCH/etc" ORIGAITV_SHARE_DROP="$SCRATCH/drop" ORIGAITV_SHARE_WORK="$SCRATCH/work" ORIGAITV_SHARE_MOUNTS="$SCRATCH/mnt"
export ORIGAITV_SHARE_PAUSE=0 STATE="$SCRATCH/state"
mkdir -p "$ORIGAITV_SHARE_DROP" "$STATE" "$SCRATCH/bin"
: >"$STATE/mounted"

fake() {
  printf '#!/bin/bash\n%s\n' "$2" >"$SCRATCH/bin/$1"
  chmod +x "$SCRATCH/bin/$1"
}
# mount.cifs as it answers: what's in mount-fail, or mounted.
fake mount '
printf "%s\n" "$*" >>"$STATE/mount.log"
point=$4
options=$6
cred=${options#*credentials=}
cp "${cred%%,*}" "$STATE/cred-seen" 2>/dev/null || true
if [[ -s $STATE/mount-fail ]]; then cat "$STATE/mount-fail" >&2; exit 32; fi
echo "$point" >>"$STATE/mounted"'
fake mountpoint 'grep -qxF -- "$2" "$STATE/mounted"'
fake umount 'grep -vxF -- "${@: -1}" "$STATE/mounted" >"$STATE/mounted.next" || true; mv "$STATE/mounted.next" "$STATE/mounted"'
fake getent 'echo "tv:x:$2:1000::/home/tv:/bin/bash"'
export PATH="$SCRATCH/bin:$PATH"

URI="smb://radomir@nas/music"
ID=$(printf '%s' "$URI" | sha1sum | cut -c1-12)
PASSWORD='hunter2, with spaces = and more'

store() {
  "$ROOT/bin/origaitv-share-store" "$@" >>"$SCRATCH/out" 2>&1
}
# drop <json>: a request as Music leaves it, as an ordinary user's file.
drop() {
  local file
  file="$ORIGAITV_SHARE_DROP/$RANDOM$RANDOM.json"
  printf '%s' "$1" >"$file"
  chmod 600 "$file"
  if (( EUID == 0 )); then chown 1000 "$file"; fi
}
entry() {
  jq -c --arg id "${2:-$ID}" ".shares[\$id] | $1" "$ORIGAITV_ETC/shares.json"
}

store || fail "with nothing handed over, it does nothing" "$(cat "$SCRATCH/out")"
[[ ! -e $ORIGAITV_ETC/shares.json ]] || fail "and writes nothing"

owner=$(( EUID == 0 ? 1000 : EUID ))
drop "$(jq -cn --arg uri "$URI" --arg password "$PASSWORD" '{op: "add", uri: $uri, password: $password}')"
store || fail "a share with a password is kept" "$(cat "$SCRATCH/out")"
[[ -z $(ls -A "$ORIGAITV_SHARE_DROP") && -z $(ls -A "$ORIGAITV_SHARE_WORK") ]] || fail "the request is gone once it's read"
[[ $(stat -c %a "$ORIGAITV_ETC/shares/$ID.cred") == 600 && $(stat -c %a "$ORIGAITV_ETC/shares") == 700 ]] ||
  fail "ADR-038 the password is in a file only root can read"
[[ $(cat "$STATE/cred-seen") == $'username=radomir\npassword='"$PASSWORD" ]] || fail "the credentials file has the user and the password as they are" "$(cat "$STATE/cred-seen")"
[[ $(tail -n 1 "$STATE/mount.log") == "-t cifs //nas/music $ORIGAITV_SHARE_MOUNTS/$ID -o ro,credentials=$ORIGAITV_ETC/shares/$ID.cred,uid=$owner,gid=1000,forceuid,forcegid,file_mode=0444,dir_mode=0555,nosuid,nodev,noexec,iocharset=utf8" ]] ||
  fail "ADR-038 it mounts the share read-only, owned by who added it, with nothing on it run" "$(tail -n 1 "$STATE/mount.log")"
[[ $(entry '[.uri, .path, .owner, .mounted, .error] | tostring' | jq -r .) == "[\"$URI\",\"$ORIGAITV_SHARE_MOUNTS/$ID\",$owner,true,null]" ]] ||
  fail "shares.json says it's mounted, and where" "$(cat "$ORIGAITV_ETC/shares.json")"
[[ $(stat -c %a "$ORIGAITV_ETC/shares.json") == 644 ]] || fail "and the TV session can read it"
if grep -rqF hunter2 "$ORIGAITV_ETC/shares.json" "$SCRATCH/out" "$STATE/mount.log"; then fail "ADR-038 the password is in nothing but its credentials file"; fi
pass "ADR-038 a share's password is kept root's alone, and the share mounts read-only, owned by who added it"

# After a restart, nothing is mounted; as the box starts, it is again.
: >"$STATE/mounted"
store mount-all || fail "mount-all runs" "$(cat "$SCRATCH/out")"
grep -qxF "$ORIGAITV_SHARE_MOUNTS/$ID" "$STATE/mounted" || fail "ADR-038 the share mounts again as the box starts, with no one asked"
store mount-all
[[ $(grep -c -- "-t cifs" "$STATE/mount.log") == 2 ]] || fail "a share that's mounted isn't mounted twice" "$(cat "$STATE/mount.log")"
pass "ADR-038 a share with a password mounts again as the box starts"

# A NAS that isn't there yet at boot gets a few tries.
: >"$STATE/mounted"
printf 'mount error(112): Host is down\n' >"$STATE/mount-fail"
ORIGAITV_SHARE_TRIES=3 store mount-all || fail "mount-all doesn't fail the boot"
[[ $(grep -c -- "-t cifs" "$STATE/mount.log") == 5 ]] || fail "it tries a share that isn't there three times" "$(cat "$STATE/mount.log")"
[[ $(entry .error | jq -r .) == "Couldn't reach nas" ]] || fail "and says the NAS didn't answer" "$(cat "$ORIGAITV_ETC/shares.json")"
[[ -f $ORIGAITV_ETC/shares/$ID.cred ]] || fail "and keeps the password for when it's back"
: >"$STATE/mount-fail"
drop "$(jq -cn --arg uri "$URI" '{op: "mount", uri: $uri}')"
store
[[ $(entry .mounted) == true ]] || fail "Music asking again mounts it once the NAS is back" "$(cat "$ORIGAITV_ETC/shares.json")"
pass "a NAS that's away at boot gets a few tries, and Music can ask again"

# A password the NAS turns down, gio's empty answer before: now it says so,
# and a typo isn't kept.
OTHER="smb://WORKGROUP;radomir@nas/films"
OTHER_ID=$(printf '%s' "$OTHER" | sha1sum | cut -c1-12)
printf 'mount error(13): Permission denied\nRefer to the mount.cifs(8) manual page (e.g. man mount.cifs) and kernel log messages (dmesg)\n' >"$STATE/mount-fail"
drop "$(jq -cn --arg uri "$OTHER" '{op: "add", uri: $uri, password: "wrong"}')"
store
[[ $(entry .error "$OTHER_ID" | jq -r .) == "Wrong user name or password" ]] ||
  fail "a password the NAS turns down says so" "$(cat "$ORIGAITV_ETC/shares.json")"
[[ $(cat "$STATE/cred-seen") == $'username=radomir\npassword=wrong\ndomain=WORKGROUP' ]] || fail "a domain before a ; goes in the credentials" "$(cat "$STATE/cred-seen")"
[[ ! -e $ORIGAITV_ETC/shares/$OTHER_ID.cred ]] || fail "and the password it turned down isn't kept"
: >"$STATE/mount-fail"
pass "a password the NAS turns down says so, and isn't kept"

# Forgetting a share takes its mount and its password.
drop "$(jq -cn --arg uri "$URI" '{op: "remove", uri: $uri}')"
store
[[ ! -e $ORIGAITV_ETC/shares/$ID.cred && ! -e $ORIGAITV_SHARE_MOUNTS/$ID ]] || fail "ADR-038 forgetting a share removes its password and its mount"
! grep -qxF "$ORIGAITV_SHARE_MOUNTS/$ID" "$STATE/mounted" || fail "and it's unmounted"
[[ $(entry . ) == null ]] || fail "and shares.json forgets it" "$(cat "$ORIGAITV_ETC/shares.json")"
drop "$(jq -cn --arg uri "$URI" '{op: "mount", uri: $uri}')"
store
[[ $(entry .error | jq -r .) == "Type its password again" ]] || fail "a share with no password kept asks for it again" "$(cat "$ORIGAITV_ETC/shares.json")"
pass "ADR-038 forgetting a share takes its password and its mount"

# Only what it should take.
count=$(wc -l <"$STATE/mount.log")
for uri in "smb://nas/music" "smb://radomir@nas" "smb://radomir@nas/../etc" "smb://radomir@na\$s/music" "smb://radomir@nas/music%0Aevil" "smb://ra%5Cdomir@nas/music" "nfs://radomir@nas/music"; do
  drop "$(jq -cn --arg uri "$uri" '{op: "add", uri: $uri, password: "pw"}')"
  store
  bad=$(printf '%s' "$uri" | sha1sum | cut -c1-12)
  [[ $(entry .error "$bad" | jq -r .) == "That address won't work" ]] || fail "$uri isn't taken" "$(cat "$ORIGAITV_ETC/shares.json")"
done
drop "$(jq -cn --arg uri "$URI" '{op: "add", uri: $uri, password: "two\nlines"}')"
store
[[ $(entry .error | jq -r .) == "That password won't work" ]] || fail "a password with a line break in it isn't taken"
# A link in the drop folder, to a request somewhere else, is thrown away
# unread, and so is something that isn't a file.
jq -cn --arg uri "smb://radomir@nas/linked" '{op: "add", uri: $uri, password: "pw"}' >"$SCRATCH/elsewhere.json"
ln -s "$SCRATCH/elsewhere.json" "$ORIGAITV_SHARE_DROP/link.json"
mkdir "$ORIGAITV_SHARE_DROP/folder.json"
store
[[ -f $SCRATCH/elsewhere.json && -z $(ls -A "$ORIGAITV_SHARE_DROP") ]] || fail "a link and a folder are thrown away, and what the link pointed at stays"
[[ $(wc -l <"$STATE/mount.log") == "$count" ]] || fail "nothing it refused got as far as a mount" "$(tail -n 3 "$STATE/mount.log")"
if (( EUID == 0 )); then
  printf '%s' "$(jq -cn --arg uri "smb://radomir@nas/root" '{op: "add", uri: $uri, password: "pw"}')" >"$ORIGAITV_SHARE_DROP/root.json"
  store
  [[ $(entry . "$(printf '%s' "smb://radomir@nas/root" | sha1sum | cut -c1-12)") == null ]] || fail "a request from a system account is thrown away"
fi
pass "only an SMB address with a user name and a path, a one-line password, and a plain file of an ordinary user's count"

grep -qx "DirectoryNotEmpty=/var/lib/origaitv/share-drop" "$ROOT/system/origaitv-share.path" || fail "origaitv-share.path watches the drop folder"
grep -qx "ExecStart=/usr/bin/origaitv-share-store" "$ROOT/system/origaitv-share.service" || fail "origaitv-share.service runs the store"
if grep -qE "^(ProtectSystem|PrivateTmp|ProtectHome|PrivateMounts)=" "$ROOT/system/origaitv-share.service" "$ROOT/system/origaitv-shares.service"; then
  fail "the mounts are made where the TV session sees them, with no mount namespace of their own"
fi
grep -qx "ExecStart=/usr/bin/origaitv-share-store mount-all" "$ROOT/system/origaitv-shares.service" || fail "origaitv-shares.service mounts them all at boot"
grep -qx "WantedBy=multi-user.target" "$ROOT/system/origaitv-shares.service" || fail "and is enabled"
grep -qx "d /var/lib/origaitv/share-drop 1733 root root -" "$ROOT/system/tmpfiles/origaitv-shares.conf" || fail "the drop folder lets anyone add and only root read"
pass "origaitv-share.path hands the requests to root, and origaitv-shares.service mounts the shares at boot"
