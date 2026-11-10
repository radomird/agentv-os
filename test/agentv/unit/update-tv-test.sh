#!/bin/bash

# Guards updates from the TV (ADR-025): agentv-update-check, which writes what
# it found for Settings → Updates (S2.12), from the repositories and AgenTV's
# signed release.json; and agentv-update-tv, which runs the update's steps
# itself with progress for the Updating screen, root's as root and the owner's
# as the owner, never writes a sudo rule, lends sudo to the migrations alone,
# and restarts the box when it needs to.

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

# A check that couldn't look keeps what the last one found. A box's first
# check, with nothing found before it, still writes every field the TV reads:
# what's installed, and nothing new (2026-11-01, when Settings wouldn't open).
cat >"$SCRATCH/bin/checkupdates" <<'SH'
#!/bin/bash
exit 1
SH
chmod +x "$SCRATCH/bin/checkupdates"
before=$(jq -c 'del(.checked_at)' "$status")
if "$ROOT/bin/agentv-update-check" >/dev/null 2>&1; then fail "a check that couldn't look says so"; fi
[[ $(jq -Sc 'del(.checked_at) | .ok = true' "$status") == "$(jq -Sc '.ok = true' <<<"$before")" && $(jq -r .ok "$status") == "false" ]] ||
  fail "a check that couldn't look keeps what the last one found" "$(cat "$status")"
rm "$status"
if "$ROOT/bin/agentv-update-check" >/dev/null 2>&1; then fail "a first check that couldn't look says so"; fi
[[ $(jq -c '[.ok, .agentv, .omarchy, .packages, .waiting, .security, .notes]' "$status") == '[false,{"installed":"0.2.1-1","available":null},{"installed":"4.0.6-1","available":null},0,false,false,{"agentv":[],"agentv_date":null,"omarchy":[]}]' ]] ||
  fail "a first check that couldn't look still has every field the TV reads" "$(cat "$status")"
pass "a check that couldn't look keeps what it found before, and a first one still has every field the TV reads"

# --- Installing from the TV ----------------------------------------------------

# Every command the update runs is a stand-in here. Each one writes down that
# it ran, what was in the sudoers folder at that moment, whether Omarchy's
# update lock was held, and its whole environment. The update runs them with
# a clean environment, so they find their files by the paths written into
# them, not by variables. The image layer updates a box for real.
sudoers="$SCRATCH/sudoers.d"
modules="$SCRATCH/modules"
home="$SCRATCH/home"
runtime="$SCRATCH/runtime"
run_dir="$SCRATCH/run"
calls="$SCRATCH/calls"
mkdir -p "$sudoers" "$modules/$(uname -r)" "$SCRATCH/new-kernel" "$home/.config/omarchy/hooks/post-update.d" \
  "$home/.local/state/omarchy" "$runtime" "$run_dir" "$SCRATCH/env" "$SCRATCH/fail" "$SCRATCH/agentv/migrations"
gpg --batch --export "AgenTV test key" >"$SCRATCH/agentv-binary.gpg"
export AGENTV_KEYRING="$SCRATCH/agentv-binary.gpg"
export AGENTV_SUDOERS_DIR="$sudoers" AGENTV_MODULES_DIR="$modules" AGENTV_OWNER=someone AGENTV_RUN_DIR="$run_dir"
export AGENTV_OWNER_RUNTIME_DIR="$runtime" AGENTV_UPDATE_PATH="$SCRATCH/bin:$PATH" AGENTV_SUDO_REAL="$SCRATCH/real-sudo"
export AGENTV_RESTART_WAIT=0
# The check after the update, with no daemon to ask here: it finds that.
export AGENTV_AFTER_WAIT=0 AGENTV_DAEMON_URL=http://127.0.0.1:9 AGENTV_CHROMIUM_STATE="$SCRATCH/chromium"

# stub <name> [<body>]: a stand-in command. Its body runs after the notes.
stub() {
  cat >"$SCRATCH/bin/$1" <<SH
#!/bin/bash
name=$1
echo "\$name \$*" >>"$calls"
ls -A "$sudoers" >>"$SCRATCH/sudoers-seen"
flock -n "$runtime/omarchy-update.lock" true 2>/dev/null || echo "\$name" >>"$SCRATCH/locked"
env >"$SCRATCH/env/\$name"
[[ ! -f $SCRATCH/fail/\$name ]] || exit 1
${2:-}
SH
  chmod +x "$SCRATCH/bin/$1"
}

# runuser, which doesn't change user here. It only runs a command that starts
# from a clean environment, and writes down what it was asked.
cat >"$SCRATCH/bin/runuser" <<SH
#!/bin/bash
echo "runuser \$*" >>"$calls"
ls -A "$sudoers" >>"$SCRATCH/sudoers-seen"
[[ \$1 == "-u" && \$2 == "someone" && \$3 == "--" && \$4 == "env" && \$5 == "-i" ]] || { echo "runuser: not a clean environment" >>"$calls"; exit 1; }
shift 3
exec "\$@"
SH
cat >"$SCRATCH/bin/getent" <<SH
#!/bin/bash
echo "someone:x:1000:1000::$home:/bin/bash"
SH
# The real sudo, as the lending runs it for the migrations: it runs the
# command, and writes down what it was asked and with what.
cat >"$SCRATCH/real-sudo" <<SH
#!/bin/bash
echo "real sudo \$* (in \$PWD, HOME=\$HOME, LEAKED=\${LEAKED:-no})" >>"$calls"
exec "\$@"
SH
cat >"$SCRATCH/bin/pacman" <<SH
#!/bin/bash
[[ \$1 == "-Qem" ]] && { [[ -f $SCRATCH/aur ]]; exit; }
[[ \$1 == "-Q" ]] || exit 1
case "\$2" in
  agentv) if [[ -f $SCRATCH/upgraded ]]; then echo "agentv 0.3.0-1"; else echo "agentv 0.2.1-1"; fi ;;
  omarchy) echo "omarchy 4.0.6-1" ;;
  *) exit 1 ;;
esac
SH
# What agentv-tested and the check after ask: one update that waits for the
# nightly run when the test says so, and nothing new otherwise.
cat >"$SCRATCH/bin/checkupdates" <<SH
#!/bin/bash
[[ -f $SCRATCH/pending-now ]] || exit 2
cat "$SCRATCH/pending-now"
SH
cat >"$SCRATCH/bin/systemctl" <<SH
#!/bin/bash
echo "systemctl \$* (as \${USER:-nobody})" >>"$calls"
SH
# Snapper's list: two snapshots from before, and the ones the update takes.
cat >"$SCRATCH/bin/snapper" <<SH
#!/bin/bash
printf '%s\n' number 0 1 2
[[ -f $SCRATCH/snapshot-taken ]] && printf '%s\n' 3 4
SH
printf '#!/bin/bash\n' >"$SCRATCH/bin/sleep"
# shellcheck disable=SC2016 # the stand-ins' bodies are run later
printf '#!/bin/bash\n[[ $1 == "-u" ]] && { echo 0; exit; }\nexec /usr/bin/id "$@"\n' >"$SCRATCH/bin/id"
# shellcheck disable=SC2016
printf '#!/bin/bash\ncommand -v -- "$1" >/dev/null\n' >"$SCRATCH/bin/omarchy-cmd-present"
# shellcheck disable=SC2016
printf '#!/bin/bash\nexec "%s/bin/agentv-migrate" "$@"\n' "$ROOT" >"$SCRATCH/bin/agentv-migrate"
cp "$ROOT/bin/omarchy-hook" "$SCRATCH/bin/omarchy-hook"
chmod +x "$SCRATCH/bin/"* "$SCRATCH/real-sudo"

stub omarchy-update-requires-free-space
stub omarchy-update-pkg-prune
stub omarchy-snapshot "touch '$SCRATCH/snapshot-taken'; echo 'Create system snapshot'"
stub omarchy-update-keyring
stub omarchy-update-system-pkgs "touch '$SCRATCH/upgraded'
echo ':: Synchronizing package databases...'
echo '(1/4) upgrading agentv'
echo '(4/4) upgrading omarchy'"
stub omarchy-restart-shell
# Omarchy's migrations call sudo. This one sends a line through it, from a
# folder of its own, and keeps what came back and how it ended. It also tries
# to open the lent socket by its path, as a process from outside would have to.
stub omarchy-migrate "[[ \${1:-} == '--pending' ]] && exit 0
echo 'Running migration (1700000000)'
cd '$home'
command -v sudo >'$SCRATCH/which-sudo'
stat -c '%a' \"\$(dirname \"\$(command -v sudo)\")\" >'$SCRATCH/sudo-dir-mode'
echo 'through the lent sudo' | sudo sh -c 'cat; echo \"to errors\" >&2; exit 3' >'$SCRATCH/sudo-out' 2>'$SCRATCH/sudo-err'
echo \"\$?\" >'$SCRATCH/sudo-status'
if (exec 9<>\"/proc/\$\$/fd/\$AGENTV_SUDO_FD\") 2>/dev/null; then echo opened; else echo refused; fi >'$SCRATCH/by-path'"
stub omarchy-update-orphan-pkgs
stub omarchy-update-boot
stub omarchy-shell
stub omarchy-update-restart
stub omarchy-update-mise
stub yay

# One of AgenTV's own migrations, which asks sudo too.
cat >"$SCRATCH/agentv/migrations/1700000001.sh" <<SH
echo "agentv migration" >>"$calls"
sudo true
SH
# The owner's own files: a profile and an rc file that must never run, and
# two post-update hooks, their own and AgenTV's. Theirs tries for the lent
# sudo every way it could.
for file in .bash_profile .bash_login .profile .bashrc; do
  echo "echo \$0 >>'$SCRATCH/profile-ran'" >"$home/$file"
done
cat >"$home/.config/omarchy/hooks/post-update" <<SH
echo "the owner's hook" >>"$calls"
ls -A "$sudoers" >>"$SCRATCH/sudoers-seen"
env >"$SCRATCH/env/hook"
{
  echo "fd=\${AGENTV_SUDO_FD:-none}"
  [[ -e /proc/\$\$/fd/200 ]] && echo "socket still open"
  "$ROOT/bin/agentv-sudo-shim" true 2>&1; echo "shim=\$?"
  AGENTV_SUDO_FD=200 "$ROOT/bin/agentv-sudo-shim" true 2>&1; echo "shim with the number=\$?"
  ls -A "$run_dir"
} >"$SCRATCH/hook-tried" 2>&1
SH
cp "$ROOT/config/omarchy/hooks/post-update.d/agentv" "$home/.config/omarchy/hooks/post-update.d/agentv"

printf '%s\n' "agentv 0.2.1-1 -> 0.3.0-1" >"$SCRATCH/pending"
check >/dev/null

# update: one update from the TV, on a box whose migrations haven't run,
# started the way systemd would not: with a profile to trip over and a
# variable that mustn't reach any step.
updates=0
update() {
  updates=$(( updates + 1 ))
  rm -f "$SCRATCH/snapshot-taken" "$SCRATCH/upgraded" "$SCRATCH/sudoers-seen" "$SCRATCH/locked" "$SCRATCH/profile-ran" "$SCRATCH/hook-tried"
  : >"$calls"
  AGENTV_MIGRATION_STATE="$SCRATCH/migrated-$updates" BASH_ENV="$home/.bashrc" ENV="$home/.profile" LEAKED=yes \
    "$ROOT/bin/agentv-update-tv" >"$SCRATCH/out" 2>&1
}
steps() {
  grep -oE "^(omarchy-[a-z-]+|agentv migration|the owner's hook|real sudo|systemctl (restart|--user restart))" "$calls" | paste -sd, -
}

update || fail "an update from the TV goes through" "$(cat "$SCRATCH/out" "$AGENTV_UPDATE_STATE/update.log" "$calls")"
progress="$AGENTV_UPDATE_STATE/progress.json"
[[ $(steps) == "omarchy-update-requires-free-space,omarchy-update-pkg-prune,omarchy-snapshot,omarchy-update-keyring,omarchy-update-system-pkgs,omarchy-migrate,omarchy-restart-shell,omarchy-migrate,real sudo,agentv migration,real sudo,omarchy-update-orphan-pkgs,omarchy-update-boot,omarchy-shell,omarchy-update-restart,systemctl restart,systemctl --user restart,the owner's hook,omarchy-update-mise" ]] ||
  fail "the update's steps run in the order Omarchy's update has them" "$(steps | tr ',' '\n')"
[[ $(jq -c '[.state, .step, .percent, .from.agentv, .to.agentv]' "$progress") == '["done","restart",100,"0.2.1-1","0.3.0-1"]' ]] ||
  fail "S2.12 the Updating screen hears it's done" "$(cat "$progress")"
grep -q "^Running migration" "$AGENTV_UPDATE_STATE/update.log" || fail "the update's output is kept"
[[ $(jq -c '[.snapshot, .from.agentv, .widevine]' "$AGENTV_UPDATE_STATE/go-back.json") == '[3,"0.2.1-1",false]' ]] ||
  fail "S2.14 Go back returns to the first snapshot the update took" "$(cat "$AGENTV_UPDATE_STATE/go-back.json")"
[[ $(jq -c '[.checks[0].name, .checks[0].ok]' "$AGENTV_UPDATE_STATE/after.json") == '["daemon",false]' ]] ||
  fail "S2.14 the check runs after the update" "$(cat "$AGENTV_UPDATE_STATE/after.json" 2>&1)"
[[ $(jq -r '.agentv.available' "$status") == "null" ]] || fail "the check runs again after" "$(cat "$status")"
! grep -q reboot "$calls" || fail "no restart without a new kernel" "$(cat "$calls")"
pass "S2.12 Install now runs the update's steps in Omarchy's order, and says when it's done"
pass "S2.14 then it checks the box, and keeps which snapshot Go back returns to"

# H1: no sudo rule, at any point. Every step looked while it ran.
[[ ! -s $SCRATCH/sudoers-seen ]] || fail "H1 nothing is in the sudoers folder while an update runs" "$(sort -u "$SCRATCH/sudoers-seen")"
[[ -z $(ls -A "$sudoers") ]] || fail "H1 nothing is in the sudoers folder after an update" "$(ls "$sudoers")"
if grep -v '^[[:space:]]*#' "$ROOT/bin/agentv-update-tv" "$ROOT/install/tv/branding.sh" | grep -E "sudoers|NOPASSWD|visudo"; then
  fail "H1 neither an update nor first boot writes a sudo rule"
fi
grep -qx 'r! /etc/sudoers.d/99-agentv-update-\*' "$ROOT/system/tmpfiles/agentv-sudo.conf" ||
  fail "a rule left behind by a power cut on a version before this goes at the next boot"
pass "H1 an update from the TV never writes a sudo rule, and one an older version left goes at the next boot"

# Root's half: as root, with nothing of the owner's or the caller's.
for step in omarchy-update-requires-free-space omarchy-update-pkg-prune omarchy-snapshot omarchy-update-keyring omarchy-update-system-pkgs omarchy-update-orphan-pkgs omarchy-update-boot; do
  env="$SCRATCH/env/$step"
  { grep -qx "HOME=/root" "$env" && grep -qx "USER=root" "$env" && grep -qx "OMARCHY_PATH=/usr/share/omarchy" "$env" && grep -qx "OMARCHY_UPDATE_UNATTENDED=1" "$env"; } ||
    fail "H1 $step runs as root, in root's own environment" "$(cat "$env")"
  ! grep -qE "^(LEAKED|BASH_ENV|ENV)=|^(HOME|PATH)=.*$home" "$env" || fail "H1 $step has nothing of the owner's or the caller's in its environment" "$(cat "$env")"
  ! grep -q "^runuser.*$step" "$calls" || fail "H1 $step doesn't run as the owner"
done
pass "H1 root's half runs as root from a clean environment, never as the owner"

# The owner's half: as the owner, no login shell, no profile.
# (This test hands the script itself an rc file to read, which systemd never
# would. Nothing it starts may read it.)
! grep -qv "/agentv-update-tv$" "$SCRATCH/profile-ran" || fail "H1 the owner's profile and rc files never run" "$(cat "$SCRATCH/profile-ran")"
! grep -E "^runuser " "$calls" | grep -qE " (-l|-lc|--login) " || fail "H1 no login shell for the owner's half" "$(grep '^runuser' "$calls")"
[[ $(grep -c "^runuser -u someone -- env -i .* bash --noprofile --norc -c " "$calls") == $(grep -c "^runuser " "$calls") ]] ||
  fail "H1 each of the owner's steps is a plain bash with no profile" "$(grep '^runuser' "$calls")"
for step in omarchy-migrate omarchy-update-restart hook omarchy-update-mise; do
  env="$SCRATCH/env/$step"
  { grep -qx "HOME=$home" "$env" && grep -qx "USER=someone" "$env" && grep -qx "OMARCHY_PATH=/usr/share/omarchy" "$env" &&
    grep -qx "XDG_RUNTIME_DIR=$runtime" "$env" && grep -qx "DBUS_SESSION_BUS_ADDRESS=unix:path=$runtime/bus" "$env"; } ||
    fail "the owner's $step has what a login gave Omarchy's commands" "$(cat "$env")"
  ! grep -qE "^(LEAKED|BASH_ENV|ENV)=" "$env" || fail "H1 the owner's $step has nothing of the caller's in its environment" "$(cat "$env")"
done
! grep "^PATH=" "$SCRATCH/env/omarchy-migrate" | grep -q "$home" || fail "H1 nothing in the owner's home is in the migrations' PATH" "$(grep '^PATH=' "$SCRATCH/env/omarchy-migrate")"
grep "^PATH=" "$SCRATCH/env/hook" | grep -q ":$home/.local/share/mise/shims:$home/.local/bin$" || fail "the owner's hooks and mise get the PATH a login gives" "$(grep '^PATH=' "$SCRATCH/env/hook")"
pass "H1 the owner's half runs as the owner with no login shell and none of the owner's profile"

# The migrations, Omarchy's and AgenTV's, are lent a sudo that works as sudo.
[[ $(cat "$SCRATCH/which-sudo") == "$run_dir"/agentv-sudo.*/sudo && $(cat "$SCRATCH/sudo-dir-mode") == 755 ]] ||
  fail "the migrations find the lent sudo first, in a folder only root writes" "$(cat "$SCRATCH/which-sudo" "$SCRATCH/sudo-dir-mode")"
[[ $(cat "$SCRATCH/sudo-out") == "through the lent sudo" && $(cat "$SCRATCH/sudo-err") == "to errors" && $(cat "$SCRATCH/sudo-status") == 3 ]] ||
  fail "the lent sudo passes input, output, errors and how it ended" "$(cat "$SCRATCH/sudo-out" "$SCRATCH/sudo-err" "$SCRATCH/sudo-status")"
grep -qxF "real sudo sh -c cat; echo \"to errors\" >&2; exit 3 (in $home, HOME=/root, LEAKED=no)" "$calls" ||
  fail "root runs the real sudo, in the caller's folder, with its own environment" "$(grep '^real sudo' "$calls")"
grep -qx "real sudo true (in .*, HOME=/root, LEAKED=no)" "$calls" || fail "AgenTV's own migrations are lent it too" "$(grep '^real sudo' "$calls")"
[[ $(cat "$SCRATCH/by-path") == "refused" ]] || fail "H1 the lent socket can't be opened by its path"
[[ -f $SCRATCH/migrated-$updates/1700000001.sh ]] || fail "AgenTV's migration is marked done"
pass "H1 the migrations alone are lent sudo, over a socket nothing else can open"

# The owner's hooks run once it's gone, and get nothing.
tried=$(cat "$SCRATCH/hook-tried")
[[ $tried == *"fd=none"* && $tried != *"socket still open"* ]] || fail "H1 the owner's hook isn't started with the lent socket" "$tried"
[[ $tried == *"shim=1"* && $tried == *"shim with the number=1"* && $tried == *"no sudo has been lent"* ]] || fail "H1 the stand-in for sudo refuses the owner's hook" "$tried"
[[ -z $(ls -A "$run_dir") ]] || fail "H1 the folder with the stand-in is gone after the migrations" "$(ls -A "$run_dir")"
! grep "^PATH=" "$SCRATCH/env/hook" | grep -q "agentv-sudo" || fail "H1 the lent sudo isn't in the hooks' PATH" "$(grep '^PATH=' "$SCRATCH/env/hook")"
[[ $(sed -n "/^the owner's hook$/,\$p" "$calls" | grep -c "^real sudo") == 0 ]] || fail "H1 nothing runs through sudo once the owner's hooks start" "$(cat "$calls")"
pass "H1 the owner's own hooks run after the lent sudo is gone, and can't get it back"

# AgenTV's hook among them calls agentv-migrate again: nothing left to run,
# and AgenTV's services restarted once, the daemon by root and the TV
# session's units by the owner.
[[ $(grep -c "^No AgenTV migrations to run$" "$AGENTV_UPDATE_STATE/update.log") == 1 && $(grep -c "^agentv migration$" "$calls") == 1 ]] ||
  fail "the hook's agentv-migrate finds nothing left to run" "$(cat "$AGENTV_UPDATE_STATE/update.log")"
[[ $(grep -c "^systemctl restart agentv-daemon.service (as root)$" "$calls") == 1 && $(grep -c "^systemctl --user restart agentv-tv.target (as someone)$" "$calls") == 1 ]] ||
  fail "AgenTV's services restart once, the daemon as root and the TV's units as the owner" "$(grep '^systemctl' "$calls")"
pass "AgenTV's services restart once, and the owner's copy of the hook has nothing left to do"

# Omarchy's update lock is held for all of it, by the owner's own account,
# and let go after.
for step in omarchy-update-pkg-prune omarchy-update-system-pkgs omarchy-migrate omarchy-update-mise; do
  grep -qx "$step" "$SCRATCH/locked" || fail "Omarchy's update lock is held while $step runs" "$(cat "$SCRATCH/locked" 2>&1)"
done
grep -q "^runuser -u someone .*omarchy-update.lock" "$calls" || fail "the owner's account opens the lock, not root" "$(grep lock "$calls")"
flock -n "$runtime/omarchy-update.lock" true || fail "the lock is let go when the update is done"
# shellcheck disable=SC2016 # the held lock's command is run later
flock -n "$runtime/omarchy-update.lock" "$BASH" -c '"$1" >/dev/null 2>&1' _ "$ROOT/bin/agentv-update-tv" && fail "an update says so when omarchy update is already running"
[[ $(jq -c '[.state, .detail]' "$progress") == '["failed","nothing changed"]' ]] || fail "an update that couldn't start says nothing changed" "$(cat "$progress")"
grep -q "already running" "$AGENTV_UPDATE_STATE/update.log" || fail "the log says why"
pass "Omarchy's update lock is held for the whole update, so omarchy update can't run beside it"

# AUR packages are left for the desktop's terminal.
touch "$SCRATCH/aur"
update || fail "an update on a box with AUR packages goes through" "$(cat "$SCRATCH/out")"
grep -q "aren't updated from the TV" "$AGENTV_UPDATE_STATE/update.log" || fail "the log says AUR packages wait for the desktop's terminal"
! grep -q "^yay" "$calls" || fail "yay doesn't run from the TV"
rm "$SCRATCH/aur"
pass "AUR packages are left for omarchy update at the desktop's terminal, and the log says so"

# Its steps, as the Updating screen sees them: the package lines move it on.
# shellcheck disable=SC2016 # the progress function is read from the script
bash -c '
  source /dev/stdin <<<"$(sed -n "/^progress() {/,/^}/p" "$1")"
  from_agentv=a from_omarchy=b to_agentv=c STATE=$2
  progress running packages $(( 10 + 80 * 1 / 4 )) "1 of 4"
  jq -c "[.state, .step, .percent, .detail]" "$2/progress.json"
' _ "$ROOT/bin/agentv-update-tv" "$AGENTV_UPDATE_STATE" | grep -qx '\["running","packages",30,"1 of 4"\]' ||
  fail "the progress says which package of how many"
pass "the Updating screen gets the step, the percent and which package of how many"

# A new kernel, here a modules folder without the running one: the box
# restarts, and says so first. AgenTV's services are left to that restart.
rm -f "$AGENTV_UPDATE_STATE/after.json"
AGENTV_MODULES_DIR="$SCRATCH/new-kernel" update || fail "an update with a new kernel goes through" "$(cat "$SCRATCH/out")"
grep -q "^systemctl reboot" "$calls" || fail "a new kernel restarts the box" "$(cat "$calls")"
! grep -q "^systemctl.* restart agentv" "$calls" || fail "AgenTV's services are left to the restart" "$(cat "$calls")"
[[ $(jq -r .state "$progress") == "restarting" ]] || fail "the TV says it's restarting" "$(cat "$progress")"
[[ -f $AGENTV_UPDATE_STATE/check-pending && ! -f $AGENTV_UPDATE_STATE/after.json ]] ||
  fail "S2.14 the check waits for the box to be up again"
pass "S2.12 an update with a new kernel restarts the box, and the TV says so"

# One the nightly run hasn't passed yet stops before anything on the box
# changes: no snapshot, no packages, nothing as the owner.
tested 0.2.9-1
printf '%s\n' "agentv 0.2.1-1 -> 0.3.0-1" >"$SCRATCH/pending-now"
update && fail "an update that waits says so"
[[ $(jq -c '[.state, .detail]' "$progress") == '["failed","not tested yet"]' ]] ||
  fail "an update that waits for the nightly run says so" "$(cat "$progress" "$AGENTV_UPDATE_STATE/update.log")"
[[ -z $(steps) ]] || fail "nothing runs before the update is known to go ahead" "$(steps)"
[[ ! -s $SCRATCH/sudoers-seen && -z $(ls -A "$sudoers") ]] || fail "H1 and no sudo rule either"
pass "an update that waits for the nightly run says it isn't tested yet, before anything runs"
# On edge it doesn't wait.
echo edge >"$AGENTV_ETC/channel"
update || fail "on edge the update doesn't wait for the nightly run" "$(cat "$SCRATCH/out")"
grep -q "^On edge" "$AGENTV_UPDATE_STATE/update.log" || fail "the log says it's on edge"
rm "$AGENTV_ETC/channel" "$SCRATCH/pending-now"
tested 0.3.0-1
pass "on edge an update from the TV doesn't wait for the nightly run"

# A failed update that changed nothing.
touch "$SCRATCH/fail/omarchy-update-keyring"
update && fail "a failed update says so"
[[ $(jq -c '[.state, .detail]' "$progress") == '["failed","nothing changed"]' ]] ||
  fail "a failed update that changed nothing says so" "$(cat "$progress")"
[[ $(steps) == *"omarchy-update-keyring" ]] || fail "a step that fails ends the update there" "$(steps)"
[[ -z $(ls -A "$sudoers") && -z $(ls -A "$run_dir") ]] || fail "H1 nothing is left behind after a failure"
rm "$SCRATCH/fail/omarchy-update-keyring"
pass "an update that fails before anything changed says nothing changed"

# One that fails after the packages went in: a migration that doesn't finish.
touch "$SCRATCH/fail/omarchy-migrate"
update && fail "an update whose migrations fail says so"
[[ $(jq -c '[.state, .detail]' "$progress") == '["failed","the update stopped halfway"]' ]] ||
  fail "an update that fails after the packages says it stopped halfway" "$(cat "$progress")"
! grep -q "^the owner's hook$" "$calls" || fail "the owner's hooks don't run after a failed migration" "$(steps)"
[[ -z $(ls -A "$run_dir") ]] || fail "H1 the folder with the stand-in is gone after a failed migration"
rm "$SCRATCH/fail/omarchy-migrate"
pass "an update that fails after the packages went in says it stopped halfway"

# The box stays awake for it, as it did under Omarchy's own update.
grep -qx 'ExecStart=/usr/bin/systemd-inhibit --what=sleep:idle --who=AgenTV "--why=installing an update" --mode=block /usr/bin/agentv-update-tv' "$ROOT/system/agentv-update-tv.service" ||
  fail "the update's unit holds the box awake"
pass "an update from the TV holds the box awake"

# Boxes installed before start the daily check without waiting for a restart.
migration=$(grep -l "agentv-update-check.timer" "$ROOT"/migrations/agentv/*.sh)
export CALLS="$calls"
cat >"$SCRATCH/bin/sudo" <<'SH'
#!/bin/bash
echo "sudo $*" >>"$CALLS"
SH
chmod +x "$SCRATCH/bin/sudo"
: >"$CALLS"
bash "$migration" || fail "the migration runs"
grep -qx "sudo systemctl start agentv-update-check.timer" "$CALLS" || fail "the migration starts the daily check" "$(cat "$CALLS")"
pass "boxes installed before start the daily update check"
