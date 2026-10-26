#!/bin/bash

# Guards the setup hotspot (stage 4): the daemon's side and its captive page
# (hotspot.test.mts), and agentv-hotspot against stand-ins for nmcli,
# iptables, dnsmasq, systemctl and nm-online. It looks before it opens the
# network, opens it with addresses and every name pointing at the box, makes
# holes in the firewall on that interface only and takes them out again,
# joins the home Wi-Fi from a file only root can read, and opens the hotspot
# again with the reason when the password is wrong.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/hotspot.test.mts"

export AGENTV_HOTSPOT_RUN="$SCRATCH/run" AGENTV_DAEMON_PRIVATE="$SCRATCH/daemon" AGENTV_NM_CONNECTIONS="$SCRATCH/connections"
export AGENTV_HOTSPOT_DROP="$AGENTV_DAEMON_PRIVATE/hotspot-drop/request.json"
export FAKE="$SCRATCH/fake"
mkdir -p "$SCRATCH/bin" "$FAKE" "$AGENTV_DAEMON_PRIVATE/hotspot-drop"
: >"$FAKE/rules"

cat >"$SCRATCH/bin/nmcli" <<'EOF'
#!/bin/bash
echo "nmcli $*" >>"$FAKE/calls"
case "$*" in
  "-t -f DEVICE,TYPE device status") printf 'enp1s0:ethernet\nwlan0:wifi\nlo:loopback\n' ;;
  *"device wifi list --rescan yes ifname wlan0")
    printf '%s\n' '82:WPA2:home wi-fi' '40:WPA2:home wi-fi' '61::cafe' '55:WPA3:new\:net' '30:WPA1 WPA2:neighbours' '90:WPA2:AgenTV-0000' '70:WPA2:' ;;
  *"connection up uuid "*)
    if [[ -n ${FAKE_UP_FAILS:-} ]]; then echo "$FAKE_UP_FAILS" >&2; exit 4; fi ;;
  "connection load "*) cp "$3" "$FAKE/loaded" ;;
  "-g IP4.ADDRESS device show wlan0") echo "192.168.77.23/24" ;;
esac
exit 0
EOF
cat >"$SCRATCH/bin/iptables" <<'EOF'
#!/bin/bash
echo "iptables $*" >>"$FAKE/calls"
table=filter
if [[ $1 == "-t" ]]; then table=$2; shift 2; fi
case $1 in
  -I) chain=$2; shift 3; echo "$table -A $chain $*" >>"$FAKE/rules" ;;
  -A) chain=$2; shift 2; echo "$table -A $chain $*" >>"$FAKE/rules" ;;
  -S) sed -n "s/^$table //p" "$FAKE/rules" ;;
  -D) chain=$2; shift 2
    grep -vxF "$table -A $chain $*" "$FAKE/rules" >"$FAKE/rules.next" || true
    mv "$FAKE/rules.next" "$FAKE/rules" ;;
esac
EOF
cat >"$SCRATCH/bin/dnsmasq" <<'EOF'
#!/bin/bash
printf '%s\n' "$@" >"$FAKE/dnsmasq"
EOF
cat >"$SCRATCH/bin/systemctl" <<'EOF'
#!/bin/bash
echo "systemctl $*" >>"$FAKE/calls"
EOF
cat >"$SCRATCH/bin/nm-online" <<'EOF'
#!/bin/bash
[[ " $* " == *" -x "* ]] && exit "${FAKE_ONLINE:-1}"
exit 0
EOF
cat >"$SCRATCH/bin/sudo" <<'EOF'
#!/bin/bash
"$@"
EOF
chmod +x "$SCRATCH"/bin/*
export PATH="$SCRATCH/bin:$PATH"
hotspot() {
  "$ROOT/bin/agentv-hotspot" "$@" >"$SCRATCH/out" 2>&1
}
calls() {
  cat "$FAKE/calls" 2>/dev/null
}
state() {
  jq -r "$1" "$AGENTV_HOTSPOT_RUN/state.json"
}

# Opening it.
hotspot run || fail "the hotspot opens" "$(cat "$SCRATCH/out")"
jq -e '. == [
  {ssid: "home wi-fi", signal: 82, secure: true, sae: false},
  {ssid: "cafe", signal: 61, secure: false, sae: false},
  {ssid: "new:net", signal: 55, secure: true, sae: true},
  {ssid: "neighbours", signal: 30, secure: true, sae: false}
]' "$AGENTV_HOTSPOT_RUN/networks.json" >/dev/null ||
  fail "it lists what it saw before opening, strongest first, each name once and none of its own" "$(cat "$AGENTV_HOTSPOT_RUN/networks.json")"
ssid=$(state .ssid)
password=$(state .password)
[[ $ssid =~ ^AgenTV-[0-9a-f]{4}$ && $password =~ ^[a-z2-9]{10}$ ]] || fail "it has a name and a password of its own" "$ssid $password"
[[ $(state .on) == "true" && $(state .device) == "wlan0" && $(state .address) == "10.42.0.1" ]] || fail "state.json says it's on, where" "$(cat "$AGENTV_HOTSPOT_RUN/state.json")"
[[ $(stat -c %a "$AGENTV_HOTSPOT_RUN/state.json") == 644 ]] || fail "and the daemon can read it"
add=$(grep "^nmcli connection add" "$FAKE/calls")
for word in "save no" "ifname wlan0" "con-name agentv-setup" "autoconnect no" "ssid $ssid" "802-11-wireless.mode ap" "wifi-sec.key-mgmt wpa-psk" \
  "ipv4.method manual ipv4.addresses 10.42.0.1/24 ipv6.method disabled"; do
  [[ $add == *"$word"* ]] || fail "the access point has $word" "$add"
done
grep -qx "nmcli --wait 45 connection up agentv-setup" "$FAKE/calls" || fail "and comes up"
pass "it looks first, then opens AgenTV's own WPA2 network, kept in memory only, at 10.42.0.1"

expected=$(printf '%s\n' \
  "filter -A INPUT -i wlan0 -p tcp --dport 3002 -m comment --comment agentv-setup-hotspot -j ACCEPT" \
  "filter -A INPUT -i wlan0 -p tcp --dport 53 -m comment --comment agentv-setup-hotspot -j ACCEPT" \
  "filter -A INPUT -i wlan0 -p udp --dport 53 -m comment --comment agentv-setup-hotspot -j ACCEPT" \
  "filter -A INPUT -i wlan0 -p udp --dport 67 -m comment --comment agentv-setup-hotspot -j ACCEPT" \
  "nat -A PREROUTING -i wlan0 -p tcp --dport 80 -m comment --comment agentv-setup-hotspot -j REDIRECT --to-ports 3002" | sort)
[[ $(sort "$FAKE/rules") == "$expected" ]] || fail "the firewall lets in DHCP, DNS and the captive page on wlan0 only, and sends port 80 to it" "$(cat "$FAKE/rules")"
grep -q "^iptables -I INPUT 1 " "$FAKE/calls" || fail "ahead of ufw's own rules"
pass "the firewall opens for DHCP, DNS and the captive page on the hotspot's interface, with port 80 sent to 3002"

for arg in --keep-in-foreground --interface=wlan0 --except-interface=lo --bind-interfaces --no-resolv \
  "--dhcp-range=10.42.0.10,10.42.0.250,255.255.255.0,10m" "--address=/#/10.42.0.1" "--dhcp-option=114,http://10.42.0.1/" \
  "--dhcp-leasefile=$AGENTV_HOTSPOT_RUN/dnsmasq.leases"; do
  grep -qxF -- "$arg" "$FAKE/dnsmasq" || fail "dnsmasq runs with $arg" "$(cat "$FAKE/dnsmasq")"
done
pass "dnsmasq hands out addresses there and answers every name with the box"

# Again in the same boot: the same name and password, and no second set of
# holes.
: >"$FAKE/calls"
hotspot run || fail "it opens again" "$(cat "$SCRATCH/out")"
[[ $(state .ssid) == "$ssid" && $(state .password) == "$password" ]] || fail "with the same name and password in the same boot"
[[ $(sort "$FAKE/rules") == "$expected" ]] || fail "and the holes from before were taken out first" "$(cat "$FAKE/rules")"
pass "opened again in the same boot, it keeps its name and password, and its holes aren't doubled"

hotspot down || fail "it closes" "$(cat "$SCRATCH/out")"
[[ ! -s $FAKE/rules ]] || fail "and takes every hole out" "$(cat "$FAKE/rules")"
grep -qx "nmcli connection delete agentv-setup" "$FAKE/calls" || fail "and its network goes"
[[ $(state .on) == "false" && $(state .ssid) == "$ssid" ]] || fail "state.json says it's off"
SERVICE_RESULT=exit-code "$ROOT/bin/agentv-hotspot" down >/dev/null 2>&1
[[ $(state .error) == "the setup hotspot stopped" ]] || fail "when it failed, state.json says so" "$(state .error)"
pass "closing it takes its network and holes out, however it stopped"

# Joining the home Wi-Fi.
hotspot run >/dev/null || true
: >"$FAKE/calls"
printf '%s' '{"join":{"ssid":"home wi-fi","password":"cor\\rect horse;#1","hidden":false}}' >"$AGENTV_HOTSPOT_DROP"
hotspot drop || fail "it joins the home Wi-Fi" "$(cat "$SCRATCH/out")"
[[ ! -e $AGENTV_HOTSPOT_DROP ]] || fail "the drop is gone"
file=$(find "$AGENTV_NM_CONNECTIONS" -name 'agentv-*.nmconnection')
[[ -n $file && $(stat -c %a "$file") == 600 ]] || fail "into a connection file only root can read" "$(ls -l "$AGENTV_NM_CONNECTIONS")"
grep -qxF 'id=home\swi-fi' "$file" || fail "named after the network" "$(cat "$file")"
grep -qx 'ssid=104;111;109;101;32;119;105;45;102;105;' "$file" || fail "with its name as bytes" "$(cat "$file")"
grep -qxF 'psk=cor\\rect\shorse;#1' "$file" || fail "and its password escaped the way NetworkManager reads it" "$(cat "$file")"
grep -qx 'key-mgmt=wpa-psk' "$file" || fail "as WPA2"
if grep -q "hidden=" "$file"; then fail "a network it saw isn't a hidden one"; fi
uuid=$(sed -n 's/^uuid=//p' "$file")
order=$(grep -nE "^(systemctl stop agentv-hotspot.service|nmcli connection load|nmcli --wait 45 connection up uuid $uuid ifname wlan0)" "$FAKE/calls" | cut -d: -f2-)
[[ $order == $'systemctl stop agentv-hotspot.service\nnmcli connection load '"$file"$'\nnmcli --wait 45 connection up uuid '"$uuid ifname wlan0" ]] ||
  fail "it closes the hotspot, then loads the network and joins it" "$(cat "$FAKE/calls")"
if grep -qF "horse" "$FAKE/calls" "$SCRATCH/out" "$AGENTV_HOTSPOT_RUN/state.json"; then fail "the password is on no command line, in no output and not in state.json"; fi
jq -e '.on == false and .joining == null and .joined == {ssid: "home wi-fi", address: "192.168.77.23"} and .error == null' "$AGENTV_HOTSPOT_RUN/state.json" >/dev/null ||
  fail "state.json says it joined, and where" "$(cat "$AGENTV_HOTSPOT_RUN/state.json")"
pass "the home Wi-Fi goes in from a file only root can read, the hotspot closes, and the box joins it"

# A wrong password: the hotspot comes back with the reason.
rm -f "$AGENTV_NM_CONNECTIONS"/*
: >"$FAKE/calls"
printf '%s' '{"join":{"ssid":"new:net","password":"wrong password","hidden":false}}' >"$AGENTV_HOTSPOT_DROP"
if FAKE_UP_FAILS="Error: Connection activation failed: Secrets were required, but not provided." hotspot drop; then fail "a wrong password doesn't join"; fi
[[ -z $(find "$AGENTV_NM_CONNECTIONS" -name 'agentv-*') ]] || fail "and leaves no connection behind"
grep -q "^nmcli connection delete uuid " "$FAKE/calls" || fail "NetworkManager forgets it"
grep -qx "systemctl start agentv-hotspot.service" "$FAKE/calls" || fail "the hotspot opens again"
[[ $(state .error) == "that password didn't work for new:net" && $(state .joining) == "null" ]] || fail "state.json says why" "$(cat "$AGENTV_HOTSPOT_RUN/state.json")"
printf '%s' '{"join":{"ssid":"far away","password":"long enough","hidden":true}}' >"$AGENTV_HOTSPOT_DROP"
FAKE_UP_FAILS="Error: Connection activation failed: The Wi-Fi network could not be found." hotspot drop || true
[[ $(state .error) == "the tv can't see far away from here" ]] || fail "and a network out of reach says so" "$(state .error)"
pass "a wrong password opens the hotspot again, with the reason, and nothing of it stays"

# WPA3 and hidden networks, and drops that aren't right.
: >"$FAKE/calls"
printf '%s' '{"join":{"ssid":"attic","password":"upstairs1","hidden":true}}' >"$AGENTV_HOTSPOT_DROP"
hotspot drop || fail "a hidden network joins" "$(cat "$SCRATCH/out")"
grep -qx 'hidden=true' "$FAKE/loaded" || fail "as a hidden one" "$(cat "$FAKE/loaded")"
printf '%s' '{"join":{"ssid":"new:net","password":"sae password","hidden":false}}' >"$AGENTV_HOTSPOT_DROP"
hotspot drop || fail "a WPA3 network joins" "$(cat "$SCRATCH/out")"
grep -qx 'key-mgmt=sae' "$FAKE/loaded" || fail "a WPA3 network joins with SAE" "$(cat "$FAKE/loaded")"
for bad in '{"join":{"ssid":"home","password":"short"}}' '{"join":{"ssid":"","password":"long enough"}}' '{"join":{"ssid":"a\nb","password":"long enough"}}'; do
  : >"$FAKE/calls"
  printf '%s' "$bad" >"$AGENTV_HOTSPOT_DROP"
  if hotspot drop; then fail "a drop that isn't a network and password is refused: $bad"; fi
  if grep -q "connection load" "$FAKE/calls"; then fail "and nothing is joined: $bad"; fi
done
printf '%s' '{"stop":true}' >"$AGENTV_HOTSPOT_DROP"
: >"$FAKE/calls"
hotspot drop || fail "a stop closes it"
grep -qx "systemctl stop agentv-hotspot.service" "$FAKE/calls" || fail "by stopping its unit"
pass "a hidden network, a WPA3 one and setup ending each go the right way, and a drop that isn't right changes nothing"

# First boot.
: >"$FAKE/calls"
echo '{"done": true}' >"$AGENTV_DAEMON_PRIVATE/setup.json"
hotspot boot || fail "boot does nothing once setup is done"
if grep -q "systemctl start" "$FAKE/calls"; then fail "so the hotspot stays off once setup is done"; fi
echo '{"done": false}' >"$AGENTV_DAEMON_PRIVATE/setup.json"
FAKE_ONLINE=0 hotspot boot || fail "boot does nothing on a box that's online"
if grep -q "systemctl start" "$FAKE/calls"; then fail "so Ethernet goes straight to pairing"; fi
FAKE_ONLINE=1 hotspot boot || fail "boot opens the hotspot on a box with no network"
grep -qx "systemctl start --no-block agentv-hotspot.service" "$FAKE/calls" || fail "without holding up the boot" "$(cat "$FAKE/calls")"
pass "on first boot it opens only with setup not done and no network"

hotspot status
[[ $(cat "$SCRATCH/out") == "The setup hotspot is closed. The box joined new:net at 192.168.77.23."$'\n'"The last try said: that isn't a wi-fi network and password." ]] ||
  fail "status says where the box is, and the last try's reason" "$(cat "$SCRATCH/out")"
hotspot run >/dev/null || true
jq '.error = "that password didn'"'"'t work for new:net"' "$AGENTV_HOTSPOT_RUN/state.json" >"$SCRATCH/state"
mv "$SCRATCH/state" "$AGENTV_HOTSPOT_RUN/state.json"
hotspot status
[[ $(cat "$SCRATCH/out") == "The setup hotspot is on: $ssid, password $password. Phones that join get the setup page at http://10.42.0.1/."$'\n'"The last try said: that password didn't work for new:net." ]] ||
  fail "and while it's on, its name, password and the last try's reason" "$(cat "$SCRATCH/out")"
pass "status says how it stands"

grep -qx "PathExists=/var/lib/private/agentv/daemon/hotspot-drop/request.json" "$ROOT/system/agentv-hotspot.path" || fail "agentv-hotspot.path watches the daemon's drop"
grep -qx "ExecStopPost=/usr/bin/agentv-hotspot down" "$ROOT/system/agentv-hotspot.service" || fail "the hotspot's unit cleans up however it stops"
grep -qx "WantedBy=multi-user.target" "$ROOT/system/agentv-hotspot-boot.service" || fail "the first-boot check runs at boot"
grep -qx "Type=exec" "$ROOT/system/agentv-hotspot-boot.service" || fail "without holding up the TV"
if grep -q "^\[Install\]" "$ROOT/system/agentv-hotspot.service"; then fail "the hotspot itself only starts when asked"; fi
pass "its units: the hand-over as root, the first-boot check, and the hotspot only when asked"
