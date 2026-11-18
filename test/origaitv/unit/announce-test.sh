#!/bin/bash

# Guards the TV found and woken (T25.1's unit half): the box id, the wake
# fields and the daemon's hand-over with Node's own test runner, then
# origaitv-announce-set, which writes Avahi's file as root. It takes an id of
# 32 hex digits and a port and nothing else, adds the package's version,
# writes the record with the name, the version and the id and nothing more,
# and removes the file when told to stop or handed anything else, without
# echoing what was dropped. The drop goes either way. origaitv-announce.path
# watches the daemon's drop, the service runs as root with two folders to
# write, first boot opens mDNS to the home network only, and boxes installed
# before get both from a migration.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/origaitv/unit/announce.test.mts"

ID=0123456789abcdef0123456789abcdef
export ORIGAITV_ANNOUNCE_DROP="$SCRATCH/drop/announce.json" ORIGAITV_ANNOUNCE_FILE="$SCRATCH/avahi/origaitv.service" ORIGAITV_PATH="$SCRATCH/package"
mkdir -p "$SCRATCH/drop" "$SCRATCH/avahi"
fake_origaitv_path "$ORIGAITV_PATH"
announce() {
  "$ROOT/bin/origaitv-announce-set" >"$SCRATCH/out" 2>&1
}
hand() {
  printf '%s' "$1" >"$ORIGAITV_ANNOUNCE_DROP"
}

announce || fail "with nothing handed over, it does nothing" "$(cat "$SCRATCH/out")"
[[ ! -s $SCRATCH/out && ! -e $ORIGAITV_ANNOUNCE_FILE ]] || fail "and writes nothing" "$(cat "$SCRATCH/out")"
pass "with nothing handed over, it does nothing"

hand "{\"on\":true,\"id\":\"$ID\",\"port\":3001}"
announce || fail "an id and a port are taken" "$(cat "$SCRATCH/out")"
expected=$(cat <<XML
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<!-- Written by origaitv-announce-set, each time OrigaiTV's daemon starts. -->
<service-group>
  <name replace-wildcards="yes">%h</name>
  <service protocol="ipv4">
    <type>_origaitv._tcp</type>
    <port>3001</port>
    <txt-record>id=$ID</txt-record>
    <txt-record>version=0.1.0</txt-record>
  </service>
</service-group>
XML
)
[[ $(cat "$ORIGAITV_ANNOUNCE_FILE") == "$expected" ]] || fail "T25.1 Avahi's file has the type, the port, the name, the version and the id, and nothing more" "$(cat "$ORIGAITV_ANNOUNCE_FILE")"
[[ ! -e $ORIGAITV_ANNOUNCE_DROP && -z $(ls -A "$SCRATCH/drop") ]] || fail "the drop is gone, with nothing left beside it" "$(ls -A "$SCRATCH/drop")"
[[ $(ls -A "$SCRATCH/avahi") == "origaitv.service" ]] || fail "and nothing else is left in Avahi's folder" "$(ls -A "$SCRATCH/avahi")"
[[ -r $ORIGAITV_ANNOUNCE_FILE && ! -x $ORIGAITV_ANNOUNCE_FILE ]] || fail "Avahi can read it"
grep -qx "origaitv-announce-set: the TV is announced on the home network, on port 3001" "$SCRATCH/out" || fail "it says so" "$(cat "$SCRATCH/out")"
if type -P python3 >/dev/null; then
  python3 -c 'import sys, xml.dom.minidom; xml.dom.minidom.parse(sys.argv[1])' "$ORIGAITV_ANNOUNCE_FILE" || fail "the file is well-formed XML"
fi
pass "T25.1 an id and a port become Avahi's file: _origaitv._tcp on the phones' port, with the name, the version and the id"

# The same again changes nothing, so Avahi isn't made to read it twice.
touch -t 202601010000 "$ORIGAITV_ANNOUNCE_FILE"
before=$(ls -l "$ORIGAITV_ANNOUNCE_FILE")
hand "{\"on\":true,\"id\":\"$ID\",\"port\":3001}"
announce || fail "the same again is fine" "$(cat "$SCRATCH/out")"
[[ $(ls -l "$ORIGAITV_ANNOUNCE_FILE") == "$before" && ! -s $SCRATCH/out && ! -e $ORIGAITV_ANNOUNCE_DROP ]] || fail "the same again leaves the file as it is, and takes the drop" "$(cat "$SCRATCH/out")"
# A new version, after an update, is written.
printf 'ORIGAITV_VERSION=1.0.0.r3.gabc1234\n' >"$ORIGAITV_PATH/settings"
hand "{\"on\":true,\"id\":\"$ID\",\"port\":3001}"
announce || fail "a new version is taken" "$(cat "$SCRATCH/out")"
grep -qx "    <txt-record>version=1.0.0.r3.gabc1234</txt-record>" "$ORIGAITV_ANNOUNCE_FILE" || fail "the record follows the installed version" "$(cat "$ORIGAITV_ANNOUNCE_FILE")"
# The version is the package's. One that isn't a version, or no settings at
# all, as in a checkout, says dev.
printf 'ORIGAITV_VERSION=1.0</txt-record><txt-record>x=y\n' >"$ORIGAITV_PATH/settings"
hand "{\"on\":true,\"id\":\"$ID\",\"port\":3001,\"version\":\"9.9.9\"}"
announce || fail "settings with an odd version are fine" "$(cat "$SCRATCH/out")"
grep -qx "    <txt-record>version=dev</txt-record>" "$ORIGAITV_ANNOUNCE_FILE" || fail "a version that isn't one says dev, and the drop's own isn't taken" "$(cat "$ORIGAITV_ANNOUNCE_FILE")"
rm "$ORIGAITV_PATH/settings"
hand "{\"on\":true,\"id\":\"$ID\",\"port\":3001}"
announce || fail "a checkout is fine" "$(cat "$SCRATCH/out")"
grep -qx "    <txt-record>version=dev</txt-record>" "$ORIGAITV_ANNOUNCE_FILE" || fail "a checkout says dev" "$(cat "$ORIGAITV_ANNOUNCE_FILE")"
fake_origaitv_path "$ORIGAITV_PATH"
pass "the same again leaves the file alone, and the version is the package's own, never the drop's"

hand '{"on":false}'
announce || fail "told to stop, it stops" "$(cat "$SCRATCH/out")"
[[ ! -e $ORIGAITV_ANNOUNCE_FILE && ! -e $ORIGAITV_ANNOUNCE_DROP ]] || fail "T25.1 off, the file is gone, and so is the drop"
grep -qx "origaitv-announce-set: the TV isn't announced on the home network any more" "$SCRATCH/out" || fail "it says so" "$(cat "$SCRATCH/out")"
hand '{"on":false}'
announce || fail "told to stop with nothing there is fine" "$(cat "$SCRATCH/out")"
[[ ! -s $SCRATCH/out && ! -e $ORIGAITV_ANNOUNCE_DROP ]] || fail "and says nothing" "$(cat "$SCRATCH/out")"
pass "T25.1 told to stop, it takes the file away, and with none there it does nothing"

# Anything else is refused, and takes down what was published: a TV that
# says nothing is the safe way to be wrong. What was dropped isn't echoed.
refused() {
  local what=$1 status=0
  printf '<service-group/>\n' >"$ORIGAITV_ANNOUNCE_FILE"
  announce || status=$?
  (( status == 1 )) || fail "$what is refused" "$(cat "$SCRATCH/out")"
  [[ ! -e $ORIGAITV_ANNOUNCE_FILE ]] || fail "$what takes down what was published"
  [[ ! -e $ORIGAITV_ANNOUNCE_DROP && ! -L $ORIGAITV_ANNOUNCE_DROP && -z $(ls -A "$SCRATCH/drop") ]] || fail "$what: the drop is gone" "$(ls -A "$SCRATCH/drop")"
  if grep -q "evil\|EVIL" "$SCRATCH/out"; then fail "$what isn't echoed" "$(cat "$SCRATCH/out")"; fi
  grep -q "the drop isn't an id and a port, so the TV announces nothing" "$SCRATCH/out" || fail "$what: it says why" "$(cat "$SCRATCH/out")"
}
for drop in \
  'not json evil' \
  '[]' \
  '{}' \
  "{\"id\":\"$ID\",\"port\":3001}" \
  "{\"on\":\"true\",\"id\":\"$ID\",\"port\":3001}" \
  '{"on":true,"port":3001}' \
  '{"on":true,"id":"evil","port":3001}' \
  '{"on":true,"id":"0123456789ABCDEF0123456789ABCDEF","port":3001}' \
  '{"on":true,"id":"0123456789abcdef0123456789abcdef0","port":3001}' \
  '{"on":true,"id":"0123456789abcdef</txt-record>evil","port":3001}' \
  '{"on":true,"id":"0123456789abcdef0123456789abcdef\nevil","port":3001}' \
  '{"on":true,"id":["0123456789abcdef0123456789abcdef"],"port":3001}' \
  "{\"on\":true,\"id\":\"$ID\"}" \
  "{\"on\":true,\"id\":\"$ID\",\"port\":0}" \
  "{\"on\":true,\"id\":\"$ID\",\"port\":65536}" \
  "{\"on\":true,\"id\":\"$ID\",\"port\":-1}" \
  "{\"on\":true,\"id\":\"$ID\",\"port\":3001.5}" \
  "{\"on\":true,\"id\":\"$ID\",\"port\":\"3001\"}" \
  "{\"on\":true,\"id\":\"$ID\",\"port\":\"3001</port>evil\"}"; do
  hand "$drop"
  refused "a drop of $drop"
done
# A drop too long to be one: only its first kilobyte is read.
hand "{\"on\":true,\"id\":\"$ID\",\"port\":3001,\"pad\":\"$(printf 'x%.0s' $(seq 1 2000))\"}"
refused "a drop longer than a kilobyte"
# A link in the daemon's folder isn't followed, to a good drop or anywhere.
printf '{"on":true,"id":"%s","port":3001}' "$ID" >"$SCRATCH/elsewhere.json"
ln -s "$SCRATCH/elsewhere.json" "$ORIGAITV_ANNOUNCE_DROP"
refused "a link for a drop"
[[ -f $SCRATCH/elsewhere.json ]] || fail "and what it pointed at is left alone"
mkdir "$ORIGAITV_ANNOUNCE_DROP"
printf '{"on":true,"id":"%s","port":3001}' "$ID" >"$ORIGAITV_ANNOUNCE_DROP/announce.json"
refused "a folder for a drop"
pass "anything but an id of 32 hex digits and a port is refused, takes down what was published, and isn't echoed"

# No Avahi on the box: nowhere to say it.
status=0
hand "{\"on\":true,\"id\":\"$ID\",\"port\":3001}"
ORIGAITV_ANNOUNCE_FILE="$SCRATCH/none/origaitv.service" announce || status=$?
(( status == 1 )) || fail "with no folder of Avahi's, it's refused" "$(cat "$SCRATCH/out")"
grep -q "isn't there, so the TV announces nothing" "$SCRATCH/out" || fail "and it says so" "$(cat "$SCRATCH/out")"
[[ ! -e $SCRATCH/none && ! -e $ORIGAITV_ANNOUNCE_DROP ]] || fail "and makes none, and still takes the drop"
pass "with no folder of Avahi's it writes nothing, and says so"

# The units, the firewall and the migration.
path="$ROOT/system/origaitv-announce.path"
unit="$ROOT/system/origaitv-announce.service"
grep -qx "PathExists=/var/lib/origaitv/daemon/announce-drop/announce.json" "$path" || fail "origaitv-announce.path watches the daemon's drop"
grep -qx "Unit=origaitv-announce.service" "$path" || fail "and starts origaitv-announce.service"
grep -qx "WantedBy=paths.target" "$path" || fail "and is enabled with the others"
grep -qx "ExecStart=/usr/bin/origaitv-announce-set" "$unit" || fail "origaitv-announce.service runs origaitv-announce-set"
if grep -q "^User=\|^DynamicUser=" "$unit"; then fail "as root"; fi
grep -qx "ProtectSystem=strict" "$unit" || fail "with the system read-only"
grep -qx "ReadWritePaths=-/var/lib/origaitv/daemon/announce-drop -/etc/avahi/services" "$unit" || fail "but for the drop and Avahi's folder"
for line in PrivateNetwork=yes NoNewPrivileges=yes CapabilityBoundingSet=CAP_DAC_OVERRIDE ProtectHome=yes PrivateTmp=yes PrivateDevices=yes; do
  grep -qx "$line" "$unit" || fail "origaitv-announce.service has $line"
done
pass "origaitv-announce.path hands the drop to origaitv-announce.service, as root, with two folders to write and no network"

# First boot's firewall leaf, with a stand-in ufw that writes down what it's
# asked.
mkdir -p "$SCRATCH/bin"
cat >"$SCRATCH/bin/ufw" <<STUB
#!/bin/bash
printf '%s\n' "\$*" >>"$SCRATCH/ufw-calls"
STUB
chmod 755 "$SCRATCH/bin/ufw"
PATH="$SCRATCH/bin:$PATH" bash -eE -c 'source "$1"' bash "$ROOT/install/tv/firewall.sh" >"$SCRATCH/out" 2>&1 || fail "install/tv/firewall.sh runs" "$(cat "$SCRATCH/out")"
mdns=$(grep " 5353 " "$SCRATCH/ufw-calls" || true)
expected=$(printf 'allow proto udp from %s to any port 5353 comment origaitv found on your network\n' 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16)
[[ $mdns == "$expected" ]] || fail "first boot opens mDNS, UDP 5353, to the home network's ranges and to nothing else" "$mdns"
migration=$(grep -l "origaitv-announce.path" "$ROOT"/migrations/origaitv/*.sh)
grep -qx "sudo systemctl start origaitv-announce.path || true" "$migration" || fail "boxes installed before start the hand-over"
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
  grep -q "^for net in .*$net" "$migration" || fail "and get the firewall's line for $net"
done
# shellcheck disable=SC2016 # the $net is the migration's own
grep -qx '  sudo ufw allow proto udp from "$net" to any port 5353 comment "origaitv found on your network" || true' "$migration" || fail "the migration's line is first boot's"
pass "first boot opens mDNS to the home network only, and boxes installed before get the line and the hand-over from a migration"
