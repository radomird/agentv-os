#!/bin/bash

# Guards agentv-pacman-conf: AgenTV's repository sits once at the end of
# pacman.conf, survives being run again, follows a channel change and leaves
# Omarchy's own lines alone. Updates in place (S0.5) depend on it.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

cmd="$ROOT/bin/agentv-pacman-conf"
conf="$SCRATCH/pacman.conf"
fake_agentv_path "$SCRATCH/stable" stable
fake_agentv_path "$SCRATCH/edge" edge

cat >"$conf" <<'CONF'
[options]
SigLevel = Required DatabaseOptional

[omarchy]
Server = https://pkgs.omarchy.org/stable/$arch

[core]
Include = /etc/pacman.d/mirrorlist
CONF
cp "$conf" "$SCRATCH/omarchy.conf"

AGENTV_PATH="$SCRATCH/stable" "$cmd" --check --file "$conf" >/dev/null 2>&1 &&
  fail "--check fails when the repository is missing"
pass "--check fails when the repository is missing"

AGENTV_PATH="$SCRATCH/stable" "$cmd" --file "$conf" >/dev/null
grep -qxF '[agentv]' "$conf" || fail "the repository is added" "$(cat "$conf")"
grep -qxF 'Server = https://example.invalid/agentv-pkgs/releases/download/stable' "$conf" ||
  fail "the server is the stable channel's release" "$(cat "$conf")"
pass "the repository is added, on the stable channel"

[[ $(tail -n 1 "$conf") == "# END agentv" ]] || fail "the section ends the file" "$(cat "$conf")"
pass "the section ends the file"

head -n "$(wc -l <"$SCRATCH/omarchy.conf")" "$conf" | diff -q - "$SCRATCH/omarchy.conf" >/dev/null ||
  fail "Omarchy's lines are untouched" "$(cat "$conf")"
pass "Omarchy's lines are untouched"

AGENTV_PATH="$SCRATCH/stable" "$cmd" --check --file "$conf" >/dev/null || fail "--check passes once it's there"
pass "--check passes once it's there"

cp "$conf" "$SCRATCH/once.conf"
AGENTV_PATH="$SCRATCH/stable" "$cmd" --file "$conf" >/dev/null
diff -q "$conf" "$SCRATCH/once.conf" >/dev/null || fail "running it again changes nothing" "$(diff "$SCRATCH/once.conf" "$conf")"
pass "running it again changes nothing"

AGENTV_PATH="$SCRATCH/edge" "$cmd" --file "$conf" >/dev/null
(( $(grep -c '^\[agentv\]$' "$conf") == 1 )) || fail "a channel change keeps one section" "$(cat "$conf")"
grep -qxF 'Server = https://example.invalid/agentv-pkgs/releases/download/edge' "$conf" ||
  fail "a channel change moves the server" "$(cat "$conf")"
pass "a channel change moves the server and keeps one section"

# What omarchy refresh pacman does: Omarchy's template over the top.
cp "$SCRATCH/omarchy.conf" "$conf"
AGENTV_PATH="$SCRATCH/stable" "$cmd" --file "$conf" >/dev/null
grep -qxF '[agentv]' "$conf" || fail "the repository comes back after Omarchy rewrites the file"
pass "the repository comes back after Omarchy rewrites the file"

AGENTV_PATH="$SCRATCH/nowhere" "$cmd" --file "$conf" >/dev/null 2>&1 &&
  fail "it refuses to run without the package's settings"
pass "it refuses to run without the package's settings"
