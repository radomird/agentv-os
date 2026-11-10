#!/bin/bash

# Guards install/tv/services.sh (ADR-085): first boot turns off what Omarchy's
# desktop brings and a TV doesn't need. Docker's socket and printing are
# disabled and stopped, never masked, and LocalSend's port is closed in the
# firewall for both protocols. Avahi stays. It's safe to run twice, and on a
# box where a unit isn't installed. Boxes installed before get it from a
# migration. systemctl and ufw are stand-ins that write down what they're
# asked.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

leaf="$ROOT/install/tv/services.sh"
[[ -f $leaf ]] || fail "install/tv/services.sh is there"
export CALLS="$SCRATCH/calls" BOX="$SCRATCH/box"
mkdir -p "$BOX/units" "$SCRATCH/bin"

# A unit is installed when it has a file in $BOX/units, holding its state.
cat >"$SCRATCH/bin/systemctl" <<'STUB'
#!/bin/bash
echo "systemctl $*" >>"$CALLS"
case "$1" in
  list-unit-files)
    unit="${*: -1}"
    [[ -f $BOX/units/$unit ]] || exit 1
    echo "$unit $(cat "$BOX/units/$unit")"
    ;;
  disable)
    [[ $2 == "--now" ]] || exit 2
    [[ -f $BOX/units/$3 ]] || { echo "Unit file $3 does not exist." >&2; exit 1; }
    echo disabled >"$BOX/units/$3"
    ;;
  *) exit 2 ;;
esac
STUB
# The firewall's rules, a line each. Deleting one that isn't there is fine
# by ufw, which says so and exits 0.
cat >"$SCRATCH/bin/ufw" <<'STUB'
#!/bin/bash
echo "ufw $*" >>"$CALLS"
[[ $1 == "--force" ]] && shift
if [[ $1 == "delete" && $2 == "allow" ]]; then
  if grep -qx "allow $3" "$BOX/rules" 2>/dev/null; then
    grep -vx "allow $3" "$BOX/rules" >"$BOX/rules.new" || true
    mv "$BOX/rules.new" "$BOX/rules"
  else
    echo "Could not delete non-existent rule"
  fi
  exit 0
fi
exit 2
STUB
chmod 755 "$SCRATCH/bin/systemctl" "$SCRATCH/bin/ufw"
export AGENTV_SYSTEMCTL="$SCRATCH/bin/systemctl" AGENTV_UFW="$SCRATCH/bin/ufw"

run_leaf() {
  # The way agentv-firstboot runs a leaf: sourced, under bash -eE.
  bash -eE -c 'source "$1"' bash "$leaf" 2>&1
}

# A box as Omarchy leaves it.
as_omarchy() {
  rm -f "$BOX"/units/* "$CALLS"
  for unit in docker.socket cups.service cups.socket cups.path avahi-daemon.service; do
    echo enabled >"$BOX/units/$unit"
  done
  echo disabled >"$BOX/units/docker.service"
  printf '%s\n' "allow 53317/udp" "allow 53317/tcp" "allow 3001/tcp from 192.168.0.0/16" >"$BOX/rules"
}
state() { cat "$BOX/units/$1"; }

as_omarchy
output=$(run_leaf) || fail "the leaf runs" "$output"
for unit in docker.socket docker.service cups.service cups.socket cups.path; do
  [[ $(state "$unit") == "disabled" ]] || fail "ADR-085 $unit is turned off" "$(cat "$CALLS")"
  grep -qx "systemctl disable --now $unit" "$CALLS" || fail "ADR-085 $unit is disabled and stopped in one go" "$(cat "$CALLS")"
done
pass "ADR-085 first boot disables and stops Docker's socket and printing"

socket=$(grep -n "disable --now docker.socket" "$CALLS" | cut -d: -f1)
service=$(grep -n "disable --now docker.service" "$CALLS" | cut -d: -f1)
(( socket < service )) || fail "Docker's socket goes before its service, so nothing starts it again" "$(cat "$CALLS")"
pass "Docker's socket goes before its service"

if grep -q "mask" "$CALLS" || grep -qw "mask" "$leaf"; then
  fail "nothing is masked, so systemctl enable --now brings one back" "$(cat "$CALLS")"
fi
pass "nothing is masked, so a plain systemctl enable --now brings one back"

[[ $(state avahi-daemon.service) == "enabled" ]] || fail "Avahi stays on"
grep -q "avahi" "$CALLS" && fail "Avahi isn't touched" "$(cat "$CALLS")"
pass "Avahi stays, since the TV finds servers with it"

grep -q "53317" "$BOX/rules" && fail "ADR-085 LocalSend's port is closed, both protocols" "$(cat "$BOX/rules")"
for proto in udp tcp; do
  grep -qx "ufw --force delete allow 53317/$proto" "$CALLS" || fail "the rules go as Omarchy added them" "$(cat "$CALLS")"
done
grep -qx "allow 3001/tcp from 192.168.0.0/16" "$BOX/rules" || fail "the phone companion's rule stays" "$(cat "$BOX/rules")"
pass "ADR-085 LocalSend's port 53317 is closed for both protocols, and AgenTV's own rules stay"

# What it removes is what Omarchy adds. If Omarchy changes its rules, this
# says so before a box keeps a port open.
for proto in udp tcp; do
  grep -qx "ufw allow 53317/$proto" "$ROOT/install/config/firewall.sh" ||
    fail "Omarchy still opens LocalSend's port the way the leaf closes it"
done
for unit in docker.socket cups.service; do
  grep -qx "systemctl enable $unit" "$ROOT/install/config/enable-services.sh" ||
    fail "Omarchy still enables the units the leaf turns off"
done
pass "it undoes exactly what Omarchy's install turns on"

cp "$BOX/rules" "$SCRATCH/rules.once"
again=$(run_leaf) || fail "running it again works" "$again"
diff -q "$BOX/rules" "$SCRATCH/rules.once" >/dev/null || fail "running it again changes nothing"
[[ $(state docker.socket) == "disabled" && $(state cups.service) == "disabled" ]] || fail "running it again leaves them off"
pass "running it again changes nothing"

# A box without Docker or printing at all, such as a later TV profile.
rm -f "$BOX"/units/* "$CALLS"
echo enabled >"$BOX/units/avahi-daemon.service"
: >"$BOX/rules"
output=$(run_leaf) || fail "a box without Docker or CUPS is fine" "$output"
grep -q "disable" "$CALLS" && fail "a unit that isn't installed isn't asked for" "$(cat "$CALLS")"
[[ $output != *"couldn't"* ]] || fail "and nothing is reported as failed" "$output"
pass "a box where a unit isn't installed is left alone, with no error"

# No firewall command at all: the leaf still finishes.
output=$(AGENTV_UFW="$SCRATCH/bin/no-ufw" run_leaf) || fail "a box without ufw is fine" "$output"
pass "a box without ufw is fine"

grep -qF "run_logged \"\$AGENTV_INSTALL/services.sh\"" "$ROOT/bin/agentv-firstboot" || fail "first boot runs it"
after=$(grep -n 'firewall.sh"' "$ROOT/bin/agentv-firstboot" | cut -d: -f1)
mine=$(grep -n 'services.sh"' "$ROOT/bin/agentv-firstboot" | cut -d: -f1)
(( mine > after )) || fail "after AgenTV's own firewall rules"
pass "first boot runs it, after AgenTV's own firewall rules"

# Boxes installed before: a migration runs the same leaf as root.
migration=$(grep -l "install/tv/services.sh" "$ROOT"/migrations/agentv/*.sh || true)
[[ -n $migration ]] || fail "boxes installed before get it from a migration"
(( $(basename "$migration" .sh) > 1794161405 )) || fail "the migration is newer than the ones boxes had run before it"
as_omarchy
cat >"$SCRATCH/bin/sudo" <<'STUB'
#!/bin/bash
echo "sudo $*" >>"$CALLS"
exec "$@"
STUB
chmod 755 "$SCRATCH/bin/sudo"
output=$(PATH="$SCRATCH/bin:$PATH" AGENTV_PATH="$ROOT" bash -euo pipefail "$migration" 2>&1) || fail "the migration runs" "$output"
grep -q "^sudo bash $ROOT/install/tv/services.sh" "$CALLS" || fail "the migration runs the leaf as root" "$(cat "$CALLS")"
[[ $(state docker.socket) == "disabled" && $(state cups.service) == "disabled" ]] || fail "the migration turns them off"
grep -q "53317" "$BOX/rules" && fail "the migration closes LocalSend's port"
pass "boxes installed before get the same from a migration, as root"
