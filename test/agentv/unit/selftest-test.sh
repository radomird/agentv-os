#!/bin/bash

# Guards bin/agentv-selftest, the stage 0 NUC checks, against fake system
# tools: S0.2's disk, autologin and welcome checks, and S0.3's access point
# check, hotspot and Wi-Fi restore. The real radio is the image layer's job
# (a virtual one) and the NUC's.

# shellcheck disable=SC2016 # the fakes' bodies are run later, by the script under test
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

selftest="$ROOT/bin/agentv-selftest"
fakes="$SCRATCH/bin"
state="$SCRATCH/state"
mkdir -p "$fakes" "$state"

fake() {
  printf '#!/bin/bash\n%s\n' "$2" >"$fakes/$1"
  chmod +x "$fakes/$1"
}

fake sudo 'exec "$@"'
fake findmnt 'echo /dev/nvme0n1p2'
fake lsblk 'cat "$STATE/lsblk"'
fake loginctl 'echo "2 1000 radomir seat0 1234 user tty1 no -"'
fake curl 'cat "$STATE/health"'
fake ip 'cat "$STATE/ip" 2>/dev/null || true'
fake iw '
case "$1" in
  phy)
    # Real radios print thousands of lines, so a reader that stops early breaks the pipe.
    printf "Wiphy phy0\n\tSupported interface modes:\n%s\n\tBand 1:\n" "$(cat "$STATE/modes")"
    yes "$(printf "\t\t * 2412.0 MHz [1] (22.0 dBm)")" | head -n 20000
    ;;
  dev)
    if [[ $(cat "$STATE/active" 2>/dev/null) == hotspot ]]; then
      printf "\ttype AP\n\tchannel 6 (2437 MHz)\n"
    else
      printf "\ttype managed\n"
    fi
    ;;
esac'
# NetworkManager with one Wi-Fi device, wlan0, and a home network it may be on.
fake nmcli '
args="$*"
case "$args" in
  "-t -f DEVICE,TYPE device status") cat "$STATE/devices" ;;
  "radio wifi") echo enabled ;;
  "-g UUID,DEVICE connection show --active")
    case $(cat "$STATE/active" 2>/dev/null) in
      home) echo "1111-home:wlan0" ;;
      hotspot) echo "2222-hotspot:wlan0" ;;
    esac
    ;;
  "connection add "*) [[ -f $STATE/refuse ]] && exit 4; touch "$STATE/profile" ;;
  "--wait 45 connection up agentv-selftest-hotspot") [[ -f $STATE/no-ap ]] || echo hotspot >"$STATE/active" ;;
  "-g GENERAL.STATE connection show agentv-selftest-hotspot")
    [[ $(cat "$STATE/active" 2>/dev/null) == hotspot ]] && echo activated
    ;;
  "connection down agentv-selftest-hotspot") rm -f "$STATE/active" ;;
  "connection delete agentv-selftest-hotspot") rm -f "$STATE/profile" ;;
  "--wait 45 connection up uuid 1111-home") echo home >"$STATE/active" ;;
  "-g NAME connection show") echo Home; [[ -f $STATE/profile ]] && echo agentv-selftest-hotspot ;;
  "-g connection.id connection show uuid 1111-home") echo Home ;;
  *) echo "fake nmcli: unexpected: $args" >&2; exit 9 ;;
esac'

# run [args...]: the selftest against the fakes, in the same bash as this
# test, so bash 5 runs it too and not only the Mac's bash 3.2; its output in
# $SCRATCH/out.
fake_agentv_path "$SCRATCH/agentv"

run() {
  env PATH="$fakes:$PATH" STATE="$state" AGENTV_PATH="$SCRATCH/agentv" AGENTV_SDDM_CONF="$SCRATCH/sddm.conf" \
    "$BASH" "$selftest" "$@" >"$SCRATCH/out" 2>&1
}

# A healthy box: unencrypted, autologin, welcome shown, a Wi-Fi card that does
# AP, on its home network.
healthy() {
  rm -rf "${state:?}" "${SCRATCH:?}/sddm.conf.d" && mkdir -p "$state" "$SCRATCH/sddm.conf.d"
  printf 'part\ndisk\n' >"$state/lsblk"
  printf '[Autologin]\nUser=radomir\nSession=omarchy.desktop\n' >"$SCRATCH/sddm.conf.d/agentv-autologin.conf"
  echo '{"ok": true, "welcome_shown": true, "welcome_shown_at": "2026-10-23T08:00:00Z"}' >"$state/health"
  printf 'wlan0:wifi\nlo:loopback\n' >"$state/devices"
  printf '\t\t * IBSS\n\t\t * managed\n\t\t * AP\n\t\t * monitor\n' >"$state/modes"
  echo home >"$state/active"
}

healthy
run || fail "a healthy box passes" "$(cat "$SCRATCH/out")"
grep -q "^pass S0.2 the root disk isn't encrypted" "$SCRATCH/out" || fail "it says the disk isn't encrypted" "$(cat "$SCRATCH/out")"
grep -q "^pass S0.2 radomir logs in on their own (session 2 on seat0)" "$SCRATCH/out" || fail "it finds the autologin session" "$(cat "$SCRATCH/out")"
grep -q "^pass S0.2 the TV setup welcome screen was shown" "$SCRATCH/out" || fail "it reads welcome_shown" "$(cat "$SCRATCH/out")"
grep -q "^pass S0.3 NetworkManager brought up a WPA2 hotspot in AP mode (AgenTV-selftest-[0-9a-f]* on channel 6)" "$SCRATCH/out" ||
  fail "it brings up the hotspot" "$(cat "$SCRATCH/out")"
grep -q "^pass S0.3 Wi-Fi is back on Home" "$SCRATCH/out" || fail "it puts Wi-Fi back" "$(cat "$SCRATCH/out")"
[[ $(tail -n 1 "$SCRATCH/out") == "S0.2 pass, S0.3 pass" ]] || fail "it ends with a line per id" "$(cat "$SCRATCH/out")"
[[ ! -f $state/profile ]] || fail "the test hotspot is gone afterwards"
pass "S0.2 and S0.3 pass on a healthy box, and Wi-Fi goes back to its network"

healthy
printf 'crypt\npart\ndisk\n' >"$state/lsblk"
! run S0.2 || fail "an encrypted disk fails"
grep -q "^fail S0.2 the root disk is encrypted" "$SCRATCH/out" || fail "it says the disk is encrypted" "$(cat "$SCRATCH/out")"
[[ $(tail -n 1 "$SCRATCH/out") == "S0.2 fail" ]] || fail "only S0.2 runs when asked" "$(cat "$SCRATCH/out")"
pass "S0.2 fails on an encrypted root disk"

healthy
rm "$SCRATCH/sddm.conf.d/agentv-autologin.conf"
echo '{"ok": true, "welcome_shown": false}' >"$state/health"
! run S0.2 || fail "no autologin and no welcome fail"
grep -q "^fail S0.2 nobody logs in on their own" "$SCRATCH/out" || fail "it says nobody logs in" "$(cat "$SCRATCH/out")"
grep -q "^fail S0.2 the TV setup welcome screen hasn't been shown" "$SCRATCH/out" || fail "it says the welcome wasn't shown" "$(cat "$SCRATCH/out")"
pass "S0.2 fails without autologin and without the welcome screen"

healthy
printf '\t\t * managed\n\t\t * monitor\n' >"$state/modes"
! run S0.3 || fail "a card without AP fails"
grep -q "^fail S0.3 the Wi-Fi device can't be an access point" "$SCRATCH/out" || fail "it says the card can't do AP" "$(cat "$SCRATCH/out")"
[[ $(cat "$state/active") == home ]] || fail "it leaves Wi-Fi alone when it can't test"
pass "S0.3 fails on a card that can't be an access point"

healthy
printf 'lo:loopback\n' >"$state/devices"
! run S0.3 || fail "no Wi-Fi device fails"
grep -q "^fail S0.3 NetworkManager has no Wi-Fi device" "$SCRATCH/out" || fail "it says there's no Wi-Fi" "$(cat "$SCRATCH/out")"
pass "S0.3 fails when there's no Wi-Fi device"

healthy
touch "$state/no-ap"
! run S0.3 || fail "a hotspot that doesn't come up fails"
grep -q "^fail S0.3 NetworkManager didn't bring up the hotspot" "$SCRATCH/out" || fail "it says the hotspot didn't come up" "$(cat "$SCRATCH/out")"
[[ $(cat "$state/active") == home && ! -f $state/profile ]] || fail "it still puts Wi-Fi back"
pass "S0.3 fails when the hotspot doesn't come up, and still puts Wi-Fi back"

healthy
echo "3: wlan0    inet 192.168.1.20/24 brd 192.168.1.255 scope global wlan0" >"$state/ip"
! SSH_CONNECTION="192.168.1.10 50000 192.168.1.20 22" run S0.3 || fail "S0.3 over SSH on Wi-Fi doesn't pass"
grep -q "^fail S0.3 not run: this SSH session goes over wlan0" "$SCRATCH/out" || fail "it says why it didn't run" "$(cat "$SCRATCH/out")"
[[ $(cat "$state/active") == home && ! -f $state/profile ]] || fail "it doesn't touch Wi-Fi over SSH on Wi-Fi"
pass "S0.3 doesn't take over Wi-Fi from an SSH session that runs over it"

# Something nobody planned for, here od failing, is still a fail line.
healthy
fake od 'exit 1'
! run S0.3 || fail "a selftest that stops halfway doesn't pass"
rm -f "$fakes/od"
grep -q "^fail S0.3 the selftest stopped at line [0-9]*; send this whole output" "$SCRATCH/out" ||
  fail "a selftest that stops halfway says so" "$(cat "$SCRATCH/out")"
pass "a selftest that stops halfway says so on a fail line"
