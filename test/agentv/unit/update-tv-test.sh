#!/bin/bash

# Guards updates from the TV (ADR-025): agentv-update-check, which writes what
# it found for Settings → Updates (S2.12), from the repositories and AgenTV's
# signed release.json; and agentv-update-tv, which runs agentv update as the
# box's owner with progress for the Updating screen, lets the owner use sudo
# for that update only, and restarts the box when it needs to.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

export GNUPGHOME="$SCRATCH/gnupg"
mkdir -m 700 "$GNUPGHOME"
gpg --batch --quiet --pinentry-mode loopback --passphrase '' --quick-gen-key "AgenTV test key" ed25519 sign never 2>/dev/null
gpg --batch --quiet --pinentry-mode loopback --passphrase '' --quick-gen-key "Someone else" ed25519 sign never 2>/dev/null
gpg --batch --armor --export "AgenTV test key" >"$SCRATCH/agentv.gpg"
export AGENTV_KEYRING="$SCRATCH/agentv.gpg"

sign() {
  gpg --batch --yes --quiet --pinentry-mode loopback --passphrase '' --local-user "$2" \
    --detach-sign --output "$1.sig" "$1"
}

# The box: its settings, a repository folder with release.json, Omarchy's
# notes, pacman's installed versions, and the update state folder.
fake_agentv_path "$SCRATCH/agentv"
repo="$SCRATCH/repo"
mkdir -p "$repo/stable" "$SCRATCH/omarchy" "$SCRATCH/bin"
sed -i "s|^AGENTV_REPO_URL=.*|AGENTV_REPO_URL=file://$repo|" "$SCRATCH/agentv/settings"
sed -i "s|^AGENTV_TESTED_URL=.*|AGENTV_TESTED_URL=file://$SCRATCH/tested|" "$SCRATCH/agentv/settings"
export AGENTV_PATH="$SCRATCH/agentv" AGENTV_ETC="$SCRATCH/etc" AGENTV_UPDATE_STATE="$SCRATCH/update"
export AGENTV_OMARCHY_RELEASES="file://$SCRATCH/omarchy" AGENTV_PACMAN_CONF="$SCRATCH/pacman.conf"
: >"$AGENTV_PACMAN_CONF"

cat >"$repo/stable/release.json" <<'JSON'
{"version": "0.3.0", "date": "2026-10-22", "security": false, "omarchy": "4.0.6",
 "notes": ["tiles come in small, medium and large", "weather shows heavy rain and wind", "plex is on the apps list",
           "setup moves along faster on ethernet", "music plays straight from your nas", "a sixth line nobody sees"]}
JSON
sign "$repo/stable/release.json" "AgenTV test key"
printf '{"body": "## Faster updates\\nSome text\\n## A new theme\\n- a line"}' >"$SCRATCH/omarchy/v4.5.0"

# The nightly run's list: tested <agentv version>.
mkdir -p "$SCRATCH/tested"
tested() {
  printf '{"schema": 1, "date": "2026-10-22T03:00:00Z", "packages": {"agentv": "%s", "omarchy": "4.5.0-1"}}\n' "$1" >"$SCRATCH/tested/tested.json"
  sign "$SCRATCH/tested/tested.json" "AgenTV test key"
}
tested 0.3.0-1

cat >"$SCRATCH/bin/pacman" <<'SH'
#!/bin/bash
[[ $1 == "-Q" ]] || exit 1
case "$2" in
  agentv) echo "agentv ${FAKE_AGENTV:-0.2.1-1}" ;;
  omarchy) echo "omarchy ${FAKE_OMARCHY:-4.0.6-1}" ;;
  *) exit 1 ;;
esac
SH
chmod +x "$SCRATCH/bin/pacman"
export PATH="$SCRATCH/bin:$ROOT/bin:$PATH"

check() {
  "$ROOT/bin/agentv-update-check" --pending "$SCRATCH/pending"
}

printf '%s\n' "agentv 0.2.1-1 -> 0.3.0-1" "omarchy 4.0.6-1 -> 4.5.0-1" "chromium 141-1 -> 142-1" "linux 6.17.4-1 -> 6.17.5-1" >"$SCRATCH/pending"
out=$(check) || fail "the check runs" "$out"
status="$AGENTV_UPDATE_STATE/status.json"
[[ $(jq -c '[.agentv.installed, .agentv.available, .omarchy.installed, .omarchy.available, .packages]' "$status") == '["0.2.1-1","0.3.0-1","4.0.6-1","4.5.0-1",2]' ]] ||
  fail "S2.12 the check finds AgenTV's and Omarchy's new versions and the other packages" "$(cat "$status")"
[[ $(jq -r '.notes.agentv | length' "$status") == 5 && $(jq -r '.notes.agentv[0]' "$status") == "tiles come in small, medium and large" ]] ||
  fail "S2.12 What's new is release.json's, five lines at most" "$(jq -c .notes "$status")"
[[ $(jq -c '.notes.omarchy' "$status") == '["Faster updates","A new theme"]' ]] ||
  fail "S2.12 Omarchy's What's new is its release notes' headings" "$(jq -c .notes.omarchy "$status")"
[[ $(stat -c %a "$status") == 644 ]] || fail "the home screen's daemon can read what the check found"
pass "S2.12 the check finds the new versions, with AgenTV's and Omarchy's What's new"

# Off edge, an update the nightly run hasn't passed waits (ADR-026), and the
# check says so, so the TV doesn't offer Install now for it.
[[ $(jq -r .waiting "$status") == "false" ]] || fail "an update the nightly run passed doesn't wait" "$(cat "$status")"
tested 0.2.9-1
out=$(check) || fail "the check runs with an update that waits" "$out"
[[ $(jq -c '[.waiting, .agentv.available]' "$status") == '[true,"0.3.0-1"]' ]] ||
  fail "an update the nightly run hasn't passed waits" "$(cat "$status")"
[[ $out == *"waiting for the nightly run"* ]] || fail "the check says it waits" "$out"
mkdir -p "$AGENTV_ETC"
echo edge >"$AGENTV_ETC/channel"
check >/dev/null || fail "the check runs on edge"
[[ $(jq -c '[.waiting, .channel]' "$status") == '[false,"edge"]' ]] || fail "edge doesn't wait for the nightly run" "$(cat "$status")"
rm "$AGENTV_ETC/channel"
tested 0.3.0-1
pass "S2.12 an update the nightly run hasn't passed waits, except on edge, and the check says so"

# A release.json signed by someone else doesn't count.
sign "$repo/stable/release.json" "Someone else"
check >/dev/null || fail "the check runs with a bad release.json"
[[ $(jq -c '.notes.agentv' "$status") == "[]" && $(jq -r '.agentv.available' "$status") == "0.3.0-1" ]] ||
  fail "a release.json that isn't AgenTV's has no say" "$(cat "$status")"
pass "a release.json that isn't signed by AgenTV's key has no say"

# Nothing new.
: >"$SCRATCH/pending"
check >/dev/null
[[ $(jq -c '[.agentv.available, .omarchy.available, .packages]' "$status") == '[null,null,0]' ]] ||
  fail "with nothing new, the check says so" "$(cat "$status")"
pass "with nothing new, the check says so"

# --- Installing from the TV ----------------------------------------------------

sudoers="$SCRATCH/sudoers.d"
modules="$SCRATCH/modules"
mkdir -p "$sudoers" "$modules/$(uname -r)" "$SCRATCH/home"
export AGENTV_SUDOERS_DIR="$sudoers" AGENTV_MODULES_DIR="$modules" AGENTV_OWNER=someone CALLS="$SCRATCH/calls"
# runuser runs the update as the owner, here a stand-in agentv update that
# prints what Omarchy's and pacman's would, and checks the sudo rule is there.
cat >"$SCRATCH/bin/runuser" <<'SH'
#!/bin/bash
echo "runuser $*" >>"$CALLS"
[[ -f $AGENTV_SUDOERS_DIR/99-omarchy-nopasswd-someone ]] && echo "rule in place" >>"$CALLS"
cat "$AGENTV_SUDOERS_DIR/99-omarchy-nopasswd-someone" >>"$CALLS" 2>/dev/null
echo "Create system snapshot"
echo ":: Synchronizing package databases..."
echo "(1/4) upgrading agentv"
echo "(4/4) upgrading omarchy"
echo "Running migrations"
[[ -n ${FAKE_UPDATE_SAYS:-} ]] && echo "$FAKE_UPDATE_SAYS"
exit "${FAKE_UPDATE_STATUS:-0}"
SH
cat >"$SCRATCH/bin/getent" <<SH
#!/bin/bash
echo "someone:x:1000:1000::$SCRATCH/home:/bin/bash"
SH
cat >"$SCRATCH/bin/systemctl" <<'SH'
#!/bin/bash
echo "systemctl $*" >>"$CALLS"
SH
printf '#!/bin/bash\nexit 0\n' >"$SCRATCH/bin/visudo"
printf '#!/bin/bash\n' >"$SCRATCH/bin/sleep"
chmod +x "$SCRATCH/bin/"*

printf '%s\n' "agentv 0.2.1-1 -> 0.3.0-1" >"$SCRATCH/pending"
check >/dev/null
# The check after the update finds nothing new.
cat >"$SCRATCH/bin/checkupdates" <<'SH'
#!/bin/bash
exit 2
SH
chmod +x "$SCRATCH/bin/checkupdates"

: >"$CALLS"
out=$("$ROOT/bin/agentv-update-tv" 2>&1) || fail "an update from the TV goes through" "$out"
progress="$AGENTV_UPDATE_STATE/progress.json"
grep -q "^runuser -u someone -- env HOME=$SCRATCH/home .* OMARCHY_UPDATE_LOGGED=1 bash -lc agentv update -y$" "$CALLS" ||
  fail "it runs agentv update as the owner" "$(cat "$CALLS")"
grep -qx "rule in place" "$CALLS" || fail "the owner may use sudo while it runs"
grep -qx "Defaults:someone !authenticate" "$CALLS" || fail "including sudo -v, which Omarchy's update runs" "$(cat "$CALLS")"
[[ -z $(ls -A "$sudoers") ]] || fail "and not after" "$(ls "$sudoers")"
[[ $(jq -c '[.state, .step, .percent, .from.agentv, .to.agentv]' "$progress") == '["done","restart",100,"0.2.1-1","0.3.0-1"]' ]] ||
  fail "S2.12 the Updating screen hears it's done" "$(cat "$progress")"
grep -q "^Running migrations$" "$AGENTV_UPDATE_STATE/update.log" || fail "the update's output is kept"
[[ $(jq -r '.agentv.available' "$status") == "null" ]] || fail "the check runs again after" "$(cat "$status")"
! grep -q reboot "$CALLS" || fail "no restart without a new kernel" "$(cat "$CALLS")"
pass "S2.12 Install now runs agentv update as the owner, with sudo for that update only, and says when it's done"

# Its steps, as the Updating screen sees them: the package lines move it on.
FAKE_UPDATE_STATUS=0 bash -c '
  source /dev/stdin <<<"$(sed -n "/^progress() {/,/^}/p" "$1")"
  from_agentv=a from_omarchy=b to_agentv=c STATE=$2
  progress running packages $(( 10 + 80 * 1 / 4 )) "1 of 4"
  jq -c "[.state, .step, .percent, .detail]" "$2/progress.json"
' _ "$ROOT/bin/agentv-update-tv" "$AGENTV_UPDATE_STATE" | grep -qx '\["running","packages",30,"1 of 4"\]' ||
  fail "the progress says which package of how many"
pass "the Updating screen gets the step, the percent and which package of how many"

# A new kernel: the box restarts, and says so first.
rmdir "$modules/$(uname -r)"
: >"$CALLS"
"$ROOT/bin/agentv-update-tv" >/dev/null 2>&1 || fail "an update with a new kernel goes through"
grep -qx "systemctl reboot" "$CALLS" || fail "a new kernel restarts the box" "$(cat "$CALLS")"
[[ $(jq -r .state "$progress") == "restarting" ]] || fail "the TV says it's restarting" "$(cat "$progress")"
mkdir -p "$modules/$(uname -r)"
pass "S2.12 an update with a new kernel restarts the box, and the TV says so"

# A failed update that changed nothing.
: >"$CALLS"
FAKE_UPDATE_STATUS=1 "$ROOT/bin/agentv-update-tv" >/dev/null 2>&1 && fail "a failed update says so"
[[ $(jq -c '[.state, .detail]' "$progress") == '["failed","nothing changed"]' ]] ||
  fail "a failed update that changed nothing says so" "$(cat "$progress")"
[[ -z $(ls -A "$sudoers") ]] || fail "the sudo rule goes after a failure too"
pass "an update that fails before anything changed says nothing changed"

# One the nightly run hasn't passed yet says that instead.
FAKE_UPDATE_STATUS=1 FAKE_UPDATE_SAYS="These versions haven't passed AgenTV's nightly run yet, so the update waits:" \
  "$ROOT/bin/agentv-update-tv" >/dev/null 2>&1 && fail "an update that waits says so"
[[ $(jq -c '[.state, .detail]' "$progress") == '["failed","not tested yet"]' ]] ||
  fail "an update that waits for the nightly run says so" "$(cat "$progress")"
pass "an update that waits for the nightly run says it isn't tested yet"

# Boxes installed before start the daily check without waiting for a restart.
migration=$(grep -l "agentv-update-check.timer" "$ROOT"/migrations/agentv/*.sh)
cat >"$SCRATCH/bin/sudo" <<'SH'
#!/bin/bash
echo "sudo $*" >>"$CALLS"
SH
chmod +x "$SCRATCH/bin/sudo"
: >"$CALLS"
bash "$migration" || fail "the migration runs"
grep -qx "sudo systemctl start agentv-update-check.timer" "$CALLS" || fail "the migration starts the daily check" "$(cat "$CALLS")"
pass "boxes installed before start the daily update check"
