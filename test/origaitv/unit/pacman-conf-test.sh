#!/bin/bash

# Guards origaitv-pacman-conf: origaiTV's repository sits once at the end of
# pacman.conf, survives being run again, follows a channel change and leaves
# Omarchy's own lines alone. Updates in place (S0.5) depend on it.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

cmd="$ROOT/bin/origaitv-pacman-conf"
export ORIGAITV_ETC="$SCRATCH/no-etc"
conf="$SCRATCH/pacman.conf"
fake_origaitv_path "$SCRATCH/stable" stable
fake_origaitv_path "$SCRATCH/edge" edge

cat >"$conf" <<'CONF'
[options]
SigLevel = Required DatabaseOptional

[omarchy]
Server = https://pkgs.omarchy.org/stable/$arch

[core]
Include = /etc/pacman.d/mirrorlist
CONF
cp "$conf" "$SCRATCH/omarchy.conf"

ORIGAITV_PATH="$SCRATCH/stable" "$cmd" --check --file "$conf" >/dev/null 2>&1 &&
  fail "--check fails when the repository is missing"
pass "--check fails when the repository is missing"

ORIGAITV_PATH="$SCRATCH/stable" "$cmd" --file "$conf" >/dev/null
grep -qxF '[origaitv]' "$conf" || fail "the repository is added" "$(cat "$conf")"
grep -qxF 'Server = https://example.invalid/origaitv-pkgs/releases/download/stable' "$conf" ||
  fail "the server is the stable channel's release" "$(cat "$conf")"
pass "the repository is added, on the stable channel"

# L4: the package list's signature isn't optional for origaiTV's repository,
# so an old list can't be handed over without one.
[[ $(sed -n '/^\[origaitv\]$/,/^# END origaitv$/p' "$conf" | grep -c '^SigLevel = Required DatabaseRequired$') == 1 ]] ||
  fail "L4 origaiTV's repository needs a signed package list" "$(cat "$conf")"
pass "L4 origaiTV's repository needs a signed package list"

[[ $(tail -n 1 "$conf") == "# END origaitv" ]] || fail "the section ends the file" "$(cat "$conf")"
pass "the section ends the file"

head -n "$(wc -l <"$SCRATCH/omarchy.conf")" "$conf" | diff -q - "$SCRATCH/omarchy.conf" >/dev/null ||
  fail "Omarchy's lines are untouched" "$(cat "$conf")"
pass "Omarchy's lines are untouched"

ORIGAITV_PATH="$SCRATCH/stable" "$cmd" --check --file "$conf" >/dev/null || fail "--check passes once it's there"
pass "--check passes once it's there"

cp "$conf" "$SCRATCH/once.conf"
ORIGAITV_PATH="$SCRATCH/stable" "$cmd" --file "$conf" >/dev/null
diff -q "$conf" "$SCRATCH/once.conf" >/dev/null || fail "running it again changes nothing" "$(diff "$SCRATCH/once.conf" "$conf")"
pass "running it again changes nothing"

ORIGAITV_PATH="$SCRATCH/edge" "$cmd" --file "$conf" >/dev/null
(( $(grep -c '^\[origaitv\]$' "$conf") == 1 )) || fail "a channel change keeps one section" "$(cat "$conf")"
grep -qxF 'Server = https://example.invalid/origaitv-pkgs/releases/download/edge' "$conf" ||
  fail "a channel change moves the server" "$(cat "$conf")"
pass "a channel change moves the server and keeps one section"

# What omarchy refresh pacman does: Omarchy's template over the top.
cp "$SCRATCH/omarchy.conf" "$conf"
ORIGAITV_PATH="$SCRATCH/stable" "$cmd" --file "$conf" >/dev/null
grep -qxF '[origaitv]' "$conf" || fail "the repository comes back after Omarchy rewrites the file"
pass "the repository comes back after Omarchy rewrites the file"

ORIGAITV_PATH="$SCRATCH/nowhere" "$cmd" --file "$conf" >/dev/null 2>&1 &&
  fail "it refuses to run without the package's settings"
pass "it refuses to run without the package's settings"

# The box's own choices: a channel picked with origaitv channel, then a whole
# repository address, which wins over both.
mkdir -p "$SCRATCH/etc"
echo edge >"$SCRATCH/etc/channel"
ORIGAITV_ETC="$SCRATCH/etc" ORIGAITV_PATH="$SCRATCH/stable" "$cmd" --file "$conf" >/dev/null
grep -qxF 'Server = https://example.invalid/origaitv-pkgs/releases/download/edge' "$conf" ||
  fail "a channel the box picked wins over the package's" "$(cat "$conf")"
pass "a channel the box picked wins over the package's"

echo "http://10.0.2.2:8000/test" >"$SCRATCH/etc/repository"
ORIGAITV_ETC="$SCRATCH/etc" ORIGAITV_PATH="$SCRATCH/stable" "$cmd" --file "$conf" >/dev/null
grep -qxF 'Server = http://10.0.2.2:8000/test' "$conf" || fail "a repository address wins over both" "$(cat "$conf")"
(( $(grep -c '^\[origaitv\]$' "$conf") == 1 )) || fail "still one section" "$(cat "$conf")"
pass "a repository address wins over both, still in one section"

# A box installed before, whose section let the list go unsigned: the next
# update check or origaitv update rewrites it, and only it.
cp "$SCRATCH/omarchy.conf" "$conf"
printf '%s\n' "" "# BEGIN origaitv: added by origaitv-pacman-conf, kept at the end" "[origaitv]" "SigLevel = Required DatabaseOptional" \
  "Server = https://example.invalid/origaitv-pkgs/releases/download/stable" "# END origaitv" >>"$conf"
ORIGAITV_PATH="$SCRATCH/stable" "$cmd" --check --file "$conf" >/dev/null 2>&1 &&
  fail "L4 --check says an older box's section is out of date"
ORIGAITV_PATH="$SCRATCH/stable" "$cmd" --file "$conf" >/dev/null
(( $(grep -c '^\[origaitv\]$' "$conf") == 1 )) || fail "L4 still one section" "$(cat "$conf")"
[[ $(sed -n '/^\[origaitv\]$/,$p' "$conf" | grep -c 'DatabaseOptional') == 0 ]] || fail "L4 an older box's section is rewritten" "$(cat "$conf")"
grep -qx 'SigLevel = Required DatabaseOptional' "$conf" || fail "L4 Omarchy's own SigLevel line is left alone" "$(cat "$conf")"
pass "L4 an older box's section is rewritten to need the signature, and Omarchy's lines stay"

# A list with no signature beside it, as a box could have from before the
# signature was needed: pacman would refuse it and every install with it.
# It goes, a signed one stays, and --check touches nothing.
export ORIGAITV_PACMAN_SYNC="$SCRATCH/sync"
mkdir -p "$ORIGAITV_PACMAN_SYNC"
touch "$ORIGAITV_PACMAN_SYNC/origaitv.db" "$ORIGAITV_PACMAN_SYNC/origaitv.files" "$ORIGAITV_PACMAN_SYNC/core.db"
ORIGAITV_PATH="$SCRATCH/stable" "$cmd" --check --file "$conf" >/dev/null
[[ -e $ORIGAITV_PACMAN_SYNC/origaitv.db ]] || fail "--check leaves the lists alone"
ORIGAITV_PATH="$SCRATCH/stable" "$cmd" --file "$conf" >/dev/null
[[ ! -e $ORIGAITV_PACMAN_SYNC/origaitv.db && ! -e $ORIGAITV_PACMAN_SYNC/origaitv.files && -e $ORIGAITV_PACMAN_SYNC/core.db ]] ||
  fail "an unsigned list of origaiTV's goes, and only it" "$(ls "$ORIGAITV_PACMAN_SYNC")"
touch "$ORIGAITV_PACMAN_SYNC/origaitv.db"
echo signature >"$ORIGAITV_PACMAN_SYNC/origaitv.db.sig"
ORIGAITV_PATH="$SCRATCH/stable" "$cmd" --file "$conf" >/dev/null
[[ -e $ORIGAITV_PACMAN_SYNC/origaitv.db && -e $ORIGAITV_PACMAN_SYNC/origaitv.db.sig ]] || fail "a signed list stays" "$(ls "$ORIGAITV_PACMAN_SYNC")"
pass "a list with no signature goes so the next update fetches both, a signed one stays, and --check touches nothing"
