#!/bin/bash

# Guards the setup hotspot (stage 4): the daemon's side and its captive page
# (hotspot.test.mts), and agentv-hotspot against stand-ins for nmcli,
# iptables, dnsmasq, systemctl and nm-online. It looks before it opens the
# network, opens it with addresses and every name pointing at the box, makes
# holes in the firewall on that interface only and takes them out again,
# joins the home Wi-Fi from a file only root can read, and opens the hotspot
# again with the reason when the password is wrong. After setup, Settings
# looks at the networks nearby and joins one with the hotspot closed, and a
# join that doesn't work puts the TV back on the network it was on. And the
# watch: a TV with no network for a while opens the hotspot by itself, and
# closes it when the network is back.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

node_test "$ROOT/test/agentv/unit/hotspot.test.mts"
node_test "$ROOT/test/agentv/unit/wifi.test.mts"

export AGENTV_HOTSPOT_RUN="$SCRATCH/run" AGENTV_DAEMON_PRIVATE="$SCRATCH/daemon" AGENTV_NM_CONNECTIONS="$SCRATCH/connections"
export AGENTV_HOTSPOT_DROP="$AGENTV_DAEMON_PRIVATE/hotspot-drop/request.json"
export AGENTV_HOTSPOT_HANDED="$SCRATCH/etc/agentv/hotspot.json"
export FAKE="$SCRATCH/fake"
mkdir -p "$SCRATCH/bin" "$FAKE" "$AGENTV_DAEMON_PRIVATE/hotspot-drop"
: >"$FAKE/rules"

cat >"$SCRATCH/bin/nmcli" <<'EOF'
#!/bin/bash
echo "nmcli $*" >>"$FAKE/calls"
case "$*" in
  "-t -f DEVICE,TYPE device status")
    if [[ -n ${FAKE_NO_WIFI:-} ]]; then printf 'enp1s0:ethernet\nlo:loopback\n'; else printf 'enp1s0:ethernet\nwlan0:wifi\nlo:loopback\n'; fi ;;
  "-t -f DEVICE,TYPE,STATE,CONNECTION device status") cat "$FAKE/links" ;;
  "-t -f ACTIVE,SSID device wifi list --rescan no ifname wlan0") cat "$FAKE/on-wifi" 2>/dev/null ;;
  "-g GENERAL.CON-UUID device show wlan0") echo "${FAKE_PREVIOUS:-}" ;;
  "-t -f TYPE,NAME connection show") printf '802-3-ethernet:Wired connection 1\n802-11-wireless:agentv-setup\n%s\n' "${FAKE_KNOWN:-}" ;;
  *"device connect wlan0") [[ -z ${FAKE_REJOINS:-} ]] || cp "$FAKE/links-back" "$FAKE/links" ;;
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
[[ $1 == "is-active" ]] && exit "${FAKE_ACTIVE:-3}"
[[ $1 == "stop" && -n ${FAKE_STOP_FAILS:-} ]] && exit 1
exit 0
EOF
cat >"$SCRATCH/bin/iw" <<'EOF'
#!/bin/bash
cat "$FAKE/stations" 2>/dev/null
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

# Two of root's processes change state.json at once: the second waits for
# the first, so neither puts back a copy from before the other's change.
hotspot run >/dev/null || true
flock "$AGENTV_HOTSPOT_RUN/.state.lock" sleep 1.5 &
holder=$!
sleep 0.3
"$ROOT/bin/agentv-hotspot" down >/dev/null 2>&1 &
closer=$!
sleep 0.5
[[ $(state .on) == "true" ]] || fail "a change waits while another of root's processes is changing state.json"
wait "$holder" "$closer"
[[ $(state .on) == "false" ]] || fail "and goes in once that one is done" "$(cat "$AGENTV_HOTSPOT_RUN/state.json")"
pass "state.json is changed by one of root's processes at a time"

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
hotspot run >/dev/null || true
: >"$FAKE/calls"
printf '%s' '{"join":{"ssid":"new:net","password":"wrong password","hidden":false},"id":"0a1b2c3d4e5f6071"}' >"$AGENTV_HOTSPOT_DROP"
if FAKE_UP_FAILS="Error: Connection activation failed: Secrets were required, but not provided." hotspot drop; then fail "a wrong password doesn't join"; fi
[[ -z $(find "$AGENTV_NM_CONNECTIONS" -name 'agentv-*') ]] || fail "and leaves no connection behind"
grep -q "^nmcli connection delete uuid " "$FAKE/calls" || fail "NetworkManager forgets it"
grep -qx "systemctl start agentv-hotspot.service" "$FAKE/calls" || fail "the hotspot opens again"
[[ $(state .error) == "that password didn't work for new:net" && $(state .joining) == "null" ]] || fail "state.json says why" "$(cat "$AGENTV_HOTSPOT_RUN/state.json")"
[[ $(state .answered) == "0a1b2c3d4e5f6071" ]] || fail "and names the ask it answers" "$(cat "$AGENTV_HOTSPOT_RUN/state.json")"
printf '%s' '{"join":{"ssid":"far away","password":"long enough","hidden":true}}' >"$AGENTV_HOTSPOT_DROP"
FAKE_UP_FAILS="Error: Connection activation failed: The Wi-Fi network could not be found." hotspot drop || true
[[ $(state .error) == "the tv can't see far away from here" ]] || fail "and a network out of reach says so" "$(state .error)"
pass "a wrong password opens the hotspot again, with the reason, and nothing of it stays"

# A join cut short, as when one of its commands fails: it doesn't stay
# "joining", which would keep the watch out and every later join waiting.
hotspot run >/dev/null || true
: >"$FAKE/calls"
printf '%s' '{"join":{"ssid":"home wi-fi","password":"correct horse","hidden":false},"id":"1122334455667788"}' >"$AGENTV_HOTSPOT_DROP"
if FAKE_STOP_FAILS=1 hotspot drop; then fail "a join whose command fails doesn't pass for joined"; fi
jq -e '.joining == null and .why == "failed" and .error == "the tv couldn'"'"'t join home wi-fi" and .answered == "1122334455667788"' "$AGENTV_HOTSPOT_RUN/state.json" >/dev/null ||
  fail "a join cut short says it didn't work, and answers its ask" "$(cat "$AGENTV_HOTSPOT_RUN/state.json")"
grep -qx "systemctl start --no-block agentv-hotspot.service" "$FAKE/calls" || fail "and the hotspot it was closing opens again" "$(cat "$FAKE/calls")"
pass "a join cut short says so, and leaves nothing reading as still joining"

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
[[ $(cat "$SCRATCH/out") == "The setup hotspot is on: $(state .ssid), password $(state .password). Phones that join get the setup page at http://10.42.0.1/."$'\n'"The last try said: that password didn't work for new:net." ]] ||
  fail "and while it's on, its name, password and the last try's reason" "$(cat "$SCRATCH/out")"
pass "status says how it stands"

# A box a phone set up from the USB stick: the same network as there, even
# on Ethernet, and the file goes when setup ends.
mkdir -p "$(dirname "$AGENTV_HOTSPOT_HANDED")"
printf '%s\n' '{"ssid":"AgenTV-1a2b","password":"abcdefghjk"}' >"$AGENTV_HOTSPOT_HANDED"
: >"$FAKE/calls"
FAKE_ONLINE=0 hotspot boot || fail "boot opens the handed-over network" "$(cat "$SCRATCH/out")"
grep -qx "systemctl start --no-block agentv-hotspot.service" "$FAKE/calls" || fail "even on a box that's online, where a phone is waiting on it" "$(cat "$FAKE/calls")"
rm -f "$AGENTV_HOTSPOT_RUN/state.json"
hotspot run || fail "it opens" "$(cat "$SCRATCH/out")"
[[ $(state .ssid) == "AgenTV-1a2b" && $(state .password) == "abcdefghjk" ]] || fail "with the name and password the USB stick handed over" "$(cat "$AGENTV_HOTSPOT_RUN/state.json")"
grep -q "ssid AgenTV-1a2b .*wifi-sec.psk abcdefghjk" "$FAKE/calls" || fail "as the access point's own" "$(grep "connection add" "$FAKE/calls")"
hotspot run || fail "it opens again" "$(cat "$SCRATCH/out")"
[[ $(state .ssid) == "AgenTV-1a2b" ]] || fail "and while setup isn't done it's that network each time, as after a wrong password"
cp "$AGENTV_HOTSPOT_RUN/state.json" "$SCRATCH/first-boot-state.json"
printf '%s' '{"stop":true}' >"$AGENTV_HOTSPOT_DROP"
hotspot drop || fail "setup ending closes it"
[[ ! -e $AGENTV_HOTSPOT_HANDED ]] || fail "and the handed-over network goes with it"
pass "a box set up from the phone opens the USB stick's network again at first boot, even online, until setup ends"

# The same boot, with setup done: the TV loses its network and the watch
# opens the hotspot. state.json is still there from the first hotspot, and
# the name and password in it were the installer's.
echo '{"done": true}' >"$AGENTV_DAEMON_PRIVATE/setup.json"
hotspot run || fail "a hotspot opens after setup" "$(cat "$SCRATCH/out")"
[[ $(state .ssid) =~ ^AgenTV-[0-9a-f]{4}$ && $(state .ssid) != "AgenTV-1a2b" && $(state .password) != "abcdefghjk" ]] ||
  fail "in the boot setup ended in, a hotspot opened later doesn't have the installer's name and password" "$(cat "$AGENTV_HOTSPOT_RUN/state.json")"
later=$(state .ssid)
hotspot run || fail "it opens again" "$(cat "$SCRATCH/out")"
[[ $(state .ssid) == "$later" ]] || fail "and it keeps its own for the rest of the boot"
# Setup ended some other way, and root was never told to close the hotspot.
cp "$SCRATCH/first-boot-state.json" "$AGENTV_HOTSPOT_RUN/state.json"
hotspot run || fail "a hotspot opens after setup" "$(cat "$SCRATCH/out")"
[[ $(state .ssid) != "AgenTV-1a2b" && $(state .password) != "abcdefghjk" ]] || fail "nor when root never heard setup end" "$(cat "$AGENTV_HOTSPOT_RUN/state.json")"

# Setup ended with the file still there, as on a TV set up before the file
# went with setup: a hotspot opened later has a name and password of its
# own, and the file goes then, or at the next start.
printf '%s\n' '{"ssid":"AgenTV-1a2b","password":"abcdefghjk"}' >"$AGENTV_HOTSPOT_HANDED"
rm -f "$AGENTV_HOTSPOT_RUN/state.json"
hotspot run || fail "a hotspot opens after setup" "$(cat "$SCRATCH/out")"
[[ $(state .ssid) != "AgenTV-1a2b" && $(state .password) != "abcdefghjk" ]] || fail "after setup, a hotspot never has the installer's name and password" "$(cat "$AGENTV_HOTSPOT_RUN/state.json")"
[[ ! -e $AGENTV_HOTSPOT_HANDED ]] || fail "and the installer's file goes"
printf '%s\n' '{"ssid":"AgenTV-1a2b","password":"abcdefghjk"}' >"$AGENTV_HOTSPOT_HANDED"
hotspot boot || fail "boot does nothing once setup is done"
[[ ! -e $AGENTV_HOTSPOT_HANDED ]] || fail "a start after setup takes the installer's file away too"
echo '{"done": false}' >"$AGENTV_DAEMON_PRIVATE/setup.json"
pass "once setup is done, the installer's network is gone: no later hotspot has its name and password"

printf '%s\n' '{"ssid":"not ours","password":"x"}' >"$AGENTV_HOTSPOT_HANDED"
rm -f "$AGENTV_HOTSPOT_RUN/state.json"
: >"$FAKE/calls"
FAKE_ONLINE=0 hotspot boot >/dev/null
if grep -q "systemctl start" "$FAKE/calls"; then fail "a handed-over file that isn't AgenTV's network changes nothing"; fi
hotspot run >/dev/null || true
[[ $(state .ssid) != "not ours" ]] || fail "and isn't opened"
rm -f "$AGENTV_HOTSPOT_HANDED"
pass "a handed-over file that isn't AgenTV's own network is ignored"

# Settings, after setup: a look at the networks nearby with the hotspot
# closed, and which one the TV is on.
rm -rf "${AGENTV_HOTSPOT_RUN:?}" "${AGENTV_NM_CONNECTIONS:?}"
: >"$FAKE/calls"
printf '%s\n' 'no:cafe' 'yes:new\:net' 'no:neighbours' >"$FAKE/on-wifi"
printf '%s' '{"scan":true,"id":"aa11bb22cc33dd44"}' >"$AGENTV_HOTSPOT_DROP"
hotspot drop || fail "a look at the networks works with the hotspot closed" "$(cat "$SCRATCH/out")"
[[ $(state .answered) == "aa11bb22cc33dd44" ]] || fail "a look's answer names the ask" "$(cat "$AGENTV_HOTSPOT_RUN/state.json")"
[[ ! -e $AGENTV_HOTSPOT_DROP ]] || fail "the drop is gone"
jq -e 'map(.ssid) == ["home wi-fi", "cafe", "new:net", "neighbours"]' "$AGENTV_HOTSPOT_RUN/networks.json" >/dev/null || fail "it lists what's nearby" "$(cat "$AGENTV_HOTSPOT_RUN/networks.json")"
jq -e '.wifi == "new:net" and .radio == true and (.scanned | type) == "string" and .on != true' "$AGENTV_HOTSPOT_RUN/state.json" >/dev/null ||
  fail "state.json says which network the TV is on, and when it looked" "$(cat "$AGENTV_HOTSPOT_RUN/state.json")"
if grep -qE "connection add|connection up|systemctl start" "$FAKE/calls"; then fail "and opens no hotspot to do it" "$(cat "$FAKE/calls")"; fi
: >"$FAKE/on-wifi"
printf '%s' '{"scan":true}' >"$AGENTV_HOTSPOT_DROP"
hotspot drop
[[ $(state .wifi) == "null" ]] || fail "on a cable, it's on no Wi-Fi" "$(state .wifi)"
printf '%s' '{"scan":true}' >"$AGENTV_HOTSPOT_DROP"
FAKE_NO_WIFI=1 hotspot drop || fail "a box with no Wi-Fi says so and doesn't fail" "$(cat "$SCRATCH/out")"
[[ $(state .radio) == "false" ]] || fail "state.json says the box has no Wi-Fi" "$(cat "$AGENTV_HOTSPOT_RUN/state.json")"
pass "Settings' look lists the networks nearby and the one the TV is on, with the hotspot closed"

# A join with the hotspot closed.
printf '%s' '{"scan":true}' >"$AGENTV_HOTSPOT_DROP"
hotspot drop
: >"$FAKE/calls"
printf '%s' '{"join":{"ssid":"cafe","password":"","hidden":false}}' >"$AGENTV_HOTSPOT_DROP"
FAKE_PREVIOUS=1111-old hotspot drop || fail "an open network joins with the hotspot closed" "$(cat "$SCRATCH/out")"
jq -e '.on != true and .joining == null and .joined.ssid == "cafe" and .wifi == "cafe" and .error == null and .why == null' "$AGENTV_HOTSPOT_RUN/state.json" >/dev/null ||
  fail "state.json says the TV is on it" "$(cat "$AGENTV_HOTSPOT_RUN/state.json")"
if grep -q "wifi-security" "$FAKE/loaded"; then fail "an open network has no password"; fi
if grep -qE "systemctl start|connection add" "$FAKE/calls"; then fail "and no hotspot opened" "$(cat "$FAKE/calls")"; fi
first=$(find "$AGENTV_NM_CONNECTIONS" -name 'agentv-*.nmconnection')
: >"$FAKE/calls"
printf '%s' '{"join":{"ssid":"cafe","password":"now it has one","hidden":false}}' >"$AGENTV_HOTSPOT_DROP"
hotspot drop || fail "the same network joins again with a new password"
[[ ! -e $first && $(find "$AGENTV_NM_CONNECTIONS" -name 'agentv-*.nmconnection' | wc -l) == 1 ]] || fail "and what was kept for it before is gone" "$(ls "$AGENTV_NM_CONNECTIONS")"
grep -q "^nmcli connection delete uuid " "$FAKE/calls" || fail "from NetworkManager too"
pass "a join with the hotspot closed leaves it closed, and a network joined again replaces what was kept for it"

# One that doesn't work: back on the network from before, and no hotspot.
kept=$(find "$AGENTV_NM_CONNECTIONS" -name 'agentv-*.nmconnection')
: >"$FAKE/calls"
printf '%s\n' 'yes:cafe' >"$FAKE/on-wifi"
printf '%s' '{"join":{"ssid":"home wi-fi","password":"not this one","hidden":false}}' >"$AGENTV_HOTSPOT_DROP"
if FAKE_PREVIOUS=1111-old FAKE_UP_FAILS="Error: Connection activation failed: Secrets were required, but not provided." hotspot drop; then fail "a wrong password doesn't join"; fi
jq -e '.joining == null and .why == "password" and .error == "that password didn'"'"'t work for home wi-fi" and .wifi == "cafe" and .on != true' "$AGENTV_HOTSPOT_RUN/state.json" >/dev/null ||
  fail "state.json says why, and that the TV is back on the network from before" "$(cat "$AGENTV_HOTSPOT_RUN/state.json")"
grep -qx "nmcli --wait 30 connection up uuid 1111-old ifname wlan0" "$FAKE/calls" || fail "it goes back to the network it was on" "$(cat "$FAKE/calls")"
if grep -q "systemctl start" "$FAKE/calls"; then fail "a join from Settings that fails opens no hotspot" "$(cat "$FAKE/calls")"; fi
[[ $(find "$AGENTV_NM_CONNECTIONS" -name 'agentv-*.nmconnection') == "$kept" ]] || fail "and the network it was on is still kept"
if grep -qF "not this one" "$FAKE/calls" "$SCRATCH/out" "$AGENTV_HOTSPOT_RUN/state.json"; then fail "the password is on no command line, in no output and not in state.json"; fi
printf '%s' '{"join":{"ssid":"far away","password":"long enough","hidden":true}}' >"$AGENTV_HOTSPOT_DROP"
FAKE_UP_FAILS="Error: Connection activation failed: The Wi-Fi network could not be found." hotspot drop || true
[[ $(state .why) == "missing" ]] || fail "a network out of reach says so" "$(state .why)"
pass "a join from Settings that doesn't work puts the TV back on its network, says why, and opens no hotspot"

# The watch.
tick() {
  : >"$FAKE/calls"
  hotspot watch-tick || fail "the watch looks" "$(cat "$SCRATCH/out")"
}
opened() {
  grep -qx "systemctl start --no-block agentv-hotspot.service" "$FAKE/calls"
}
ago() {
  echo "$(( $(date +%s) - $1 ))"
}
set_state() {
  jq "$1" "$AGENTV_HOTSPOT_RUN/state.json" >"$SCRATCH/state"
  mv "$SCRATCH/state" "$AGENTV_HOTSPOT_RUN/state.json"
}
no_network='enp1s0:ethernet:unavailable:
wlan0:wifi:disconnected:
lo:loopback:connected (externally):lo'
rm -rf "${AGENTV_HOTSPOT_RUN:?}"
mkdir -p "$AGENTV_HOTSPOT_RUN"
export AGENTV_HOTSPOT_LOST_AFTER=60 AGENTV_HOTSPOT_RETRY_AFTER=300 AGENTV_HOTSPOT_REJOIN_WAIT=0 FAKE_KNOWN="802-11-wireless:home wi-fi"
printf '%s\n' "$no_network" >"$FAKE/links"

echo '{"done": false}' >"$AGENTV_DAEMON_PRIVATE/setup.json"
ago 600 >"$AGENTV_HOTSPOT_RUN/lost-since"
tick
if opened; then fail "the watch never opens the hotspot while setup isn't done"; fi
echo '{"done": true}' >"$AGENTV_DAEMON_PRIVATE/setup.json"

printf '%s\n' 'enp1s0:ethernet:connecting (getting IP configuration):Wired connection 1' 'wlan0:wifi:disconnected:' >"$FAKE/links"
ago 600 >"$AGENTV_HOTSPOT_RUN/lost-since"
tick
if opened; then fail "nor with a cable in, even one with no address yet"; fi
[[ ! -e $AGENTV_HOTSPOT_RUN/lost-since ]] || fail "and a cable ends the count"
printf '%s\n' 'enp1s0:ethernet:connected:Wired connection 1' 'wlan0:wifi:disconnected:' >"$FAKE/links"
tick
if opened; then fail "nor on a cable that's up"; fi
printf '%s\n' 'enp1s0:ethernet:unavailable:' >"$FAKE/links"
ago 600 >"$AGENTV_HOTSPOT_RUN/lost-since"
tick
if opened; then fail "nor on a box with no Wi-Fi"; fi
pass "the watch leaves the hotspot closed while setup isn't done, with a cable in, and on a box with no Wi-Fi"

printf '%s\n' "$no_network" >"$FAKE/links"
rm -f "$AGENTV_HOTSPOT_RUN/lost-since"
tick
if opened; then fail "a network just lost doesn't open the hotspot"; fi
[[ -s $AGENTV_HOTSPOT_RUN/lost-since ]] || fail "it notes when the network went"
ago 30 >"$AGENTV_HOTSPOT_RUN/lost-since"
tick
if opened; then fail "nor does one lost for less than the wait"; fi
printf '%s\n' 'enp1s0:ethernet:unavailable:' 'wlan0:wifi:connected:home wi-fi' >"$FAKE/links"
tick
[[ ! -e $AGENTV_HOTSPOT_RUN/lost-since ]] || fail "a network that came back in time ends the count"
if grep -q "systemctl st" "$FAKE/calls"; then fail "and nothing was started or stopped" "$(cat "$FAKE/calls")"; fi
printf '%s\n' "$no_network" >"$FAKE/links"
ago 61 >"$AGENTV_HOTSPOT_RUN/lost-since"
tick
opened || fail "no network for the whole wait opens the hotspot" "$(cat "$FAKE/calls")"
[[ $(state .watch) == "true" ]] || fail "and state.json says the watch opened it"
: >"$FAKE/calls"
FAKE_ACTIVE=0 hotspot watch-tick
if opened; then fail "while it's opening, it isn't started twice"; fi
ago 6 >"$AGENTV_HOTSPOT_RUN/lost-since"
: >"$FAKE/calls"
AGENTV_HOTSPOT_LOST_AFTER=5 hotspot watch-tick
opened || fail "the wait can be shortened for a check"
pass "the watch opens the hotspot after a minute with no network, not before, and the wait can be shortened"

# A TV that slept: the network went just before, and the first look after it
# wakes is hours later. That isn't a minute with no network, so the count
# starts again and NetworkManager gets its minute to join the Wi-Fi.
echo "$(ago 7205) $(ago 7200)" >"$AGENTV_HOTSPOT_RUN/lost-since"
tick
if opened; then fail "a TV just awake doesn't open the hotspot for the time it slept" "$(cat "$FAKE/calls")"; fi
read -r since _ <"$AGENTV_HOTSPOT_RUN/lost-since"
(( $(date +%s) - since < 30 )) || fail "the count starts again from the wake" "$(cat "$AGENTV_HOTSPOT_RUN/lost-since")"
echo "$(ago 61) $(ago 5)" >"$AGENTV_HOTSPOT_RUN/lost-since"
tick
opened || fail "a minute with no network, looked at all the way through, still opens it" "$(cat "$FAKE/calls")"
pass "time asleep doesn't count as time with no network"

# With the hotspot open: the network back by any route closes it.
hotspot run >/dev/null || true
set_state '.watch = true'
printf '%s\n' 'enp1s0:ethernet:unavailable:' 'wlan0:wifi:connected:agentv-setup' >"$FAKE/links"
ago 0 >"$AGENTV_HOTSPOT_RUN/opened-at"
tick
if grep -q "systemctl" "$FAKE/calls"; then fail "its own hotspot isn't a network, and it stays open" "$(cat "$FAKE/calls")"; fi
printf '%s\n' 'enp1s0:ethernet:connected:Wired connection 1' 'wlan0:wifi:connected:agentv-setup' >"$FAKE/links"
tick
grep -qx "systemctl stop agentv-hotspot.service" "$FAKE/calls" || fail "a cable that comes up closes the hotspot" "$(cat "$FAKE/calls")"
[[ $(state .watch) == "null" ]] || fail "and it's no longer the watch's"
set_state '.on = true | .watch = null'
tick
if grep -q "systemctl stop" "$FAKE/calls"; then fail "a hotspot someone opened by hand isn't the watch's to close"; fi
pass "the network coming back closes the hotspot the watch opened, and only that one"

# The router that restarts: with nobody using the hotspot's page, it closes
# now and then to look for the Wi-Fi the TV knows.
set_state '.on = true | .watch = true'
printf '%s\n' 'enp1s0:ethernet:unavailable:' 'wlan0:wifi:connected:agentv-setup' >"$FAKE/links"
printf '%s\n' 'enp1s0:ethernet:unavailable:' 'wlan0:wifi:connected:home wi-fi' >"$FAKE/links-back"
: >"$FAKE/stations"
ago 100 >"$AGENTV_HOTSPOT_RUN/opened-at"
tick
if grep -q "systemctl" "$FAKE/calls"; then fail "it doesn't look again before the wait is over"; fi
ago 301 >"$AGENTV_HOTSPOT_RUN/opened-at"
touch "$AGENTV_DAEMON_PRIVATE/hotspot-page"
tick
if grep -q "systemctl" "$FAKE/calls"; then fail "nor while someone is using the hotspot's page" "$(cat "$FAKE/calls")"; fi
# A phone that's joined and asks for nothing, as the one that set the TV up
# does from a pocket, doesn't hold the TV on the hotspot.
touch -d "10 minutes ago" "$AGENTV_DAEMON_PRIVATE/hotspot-page"
echo "Station 02:00:00:00:01:00 (on wlan0)" >"$FAKE/stations"
ago 301 >"$AGENTV_HOTSPOT_RUN/opened-at"
tick
grep -qx "systemctl stop agentv-hotspot.service" "$FAKE/calls" || fail "a phone that's only joined doesn't stop the look for the home Wi-Fi" "$(cat "$FAKE/calls")"
: >"$FAKE/stations"
set_state '.on = true'
ago 301 >"$AGENTV_HOTSPOT_RUN/opened-at"
: >"$FAKE/calls"
FAKE_KNOWN="" hotspot watch-tick
if grep -q "systemctl" "$FAKE/calls"; then fail "nor on a TV that knows no Wi-Fi to go back to" "$(cat "$FAKE/calls")"; fi
ago 301 >"$AGENTV_HOTSPOT_RUN/opened-at"
tick
order=$(grep -nE "^(systemctl stop agentv-hotspot.service|nmcli .*device wifi list --rescan yes ifname wlan0|nmcli --wait 0 device connect wlan0|systemctl start --no-block agentv-hotspot.service)" "$FAKE/calls" | cut -d: -f2- | sed 's/nmcli .*device wifi list.*/look/')
[[ $order == $'systemctl stop agentv-hotspot.service\nlook\nnmcli --wait 0 device connect wlan0\nsystemctl start --no-block agentv-hotspot.service' ]] ||
  fail "with nobody using it, it closes, looks for the Wi-Fi the TV knows, and opens again when it isn't there" "$(cat "$FAKE/calls")"
[[ $(state .watch) == "true" ]] || fail "and it's still the watch's"
set_state '.on = true'
ago 301 >"$AGENTV_HOTSPOT_RUN/opened-at"
: >"$FAKE/calls"
FAKE_REJOINS=1 hotspot watch-tick || fail "the watch looks" "$(cat "$SCRATCH/out")"
grep -qx "systemctl stop agentv-hotspot.service" "$FAKE/calls" || fail "it closes to look"
if opened; then fail "the home Wi-Fi came back, so the hotspot stays closed" "$(cat "$FAKE/calls")"; fi
[[ $(state .watch) == "null" ]] || fail "and it's no longer the watch's"
pass "with nobody using its page the hotspot closes every few minutes to look for the Wi-Fi the TV knows, and opens again only without it"

# While root joins a network, the watch keeps out of it.
set_state '.joining = "home wi-fi" | .on = false'
printf '%s\n' "$no_network" >"$FAKE/links"
ago 600 >"$AGENTV_HOTSPOT_RUN/lost-since"
tick
if grep -q "systemctl" "$FAKE/calls"; then fail "the watch leaves a join alone"; fi
[[ ! -e $AGENTV_HOTSPOT_RUN/lost-since ]] || fail "and the count starts again after it"
unset AGENTV_HOTSPOT_LOST_AFTER AGENTV_HOTSPOT_RETRY_AFTER AGENTV_HOTSPOT_REJOIN_WAIT FAKE_KNOWN
pass "the watch leaves a join that's under way alone"

grep -qx "ExecStart=/usr/bin/agentv-hotspot watch" "$ROOT/system/agentv-hotspot-watch.service" || fail "the watch has its unit"
grep -qx "WantedBy=multi-user.target" "$ROOT/system/agentv-hotspot-watch.service" || fail "which starts with the box"
if grep -qE "^(User|Environment)=" "$ROOT/system/agentv-hotspot-watch.service"; then fail "as root, with the waits it ships with"; fi
grep -qx "PathExists=/var/lib/agentv/daemon/hotspot-drop/request.json" "$ROOT/system/agentv-hotspot.path" || fail "agentv-hotspot.path watches the daemon's drop"
grep -qx "StartLimitIntervalSec=0" "$ROOT/system/agentv-hotspot-drop.service" || fail "quick hand-overs in a row never hit a start limit, which would stop the hand-over until a restart"
grep -qx "ExecStopPost=/usr/bin/agentv-hotspot down" "$ROOT/system/agentv-hotspot.service" || fail "the hotspot's unit cleans up however it stops"
grep -qx "WantedBy=multi-user.target" "$ROOT/system/agentv-hotspot-boot.service" || fail "the first-boot check runs at boot"
grep -qx "Type=exec" "$ROOT/system/agentv-hotspot-boot.service" || fail "without holding up the TV"
if grep -q "^\[Install\]" "$ROOT/system/agentv-hotspot.service"; then fail "the hotspot itself only starts when asked"; fi
pass "its units: the hand-over as root, the first-boot check, and the hotspot only when asked"
