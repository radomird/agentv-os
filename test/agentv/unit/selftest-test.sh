#!/bin/bash

# Guards bin/agentv-selftest, the NUC checks, against fake system tools and
# a fake screen daemon: stage 1's TV session checks (S1.1, S1.2, S1.5, S1.6),
# and stage 0's disk, autologin and welcome checks (S0.2) and access point,
# hotspot and Wi-Fi restore (S0.3). The real radio and TV session are the
# image layer's job and the NUC's.

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
# The daemon: /health, and the ledger (S3.3).
fake curl '
echo "$*" >>"$STATE/curl.log"
if [[ $* == *"-X DELETE"* ]]; then echo "{\"ok\":true}"
elif [[ $* == *api/ledger* ]]; then cat "$STATE/ledger" 2>/dev/null || echo "{\"ok\":true,\"rows\":[]}"
else cat "$STATE/health"; fi'
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
run S0.2 S0.3 || fail "a healthy box passes" "$(cat "$SCRATCH/out")"
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

# --- Stage 1: the TV session ------------------------------------------------

# A screen daemon that does what it's asked, from a status file: open puts
# an app in front, home the home screen, toast an overlay. A home screen
# whose process has gone comes back as a new one, as the real daemon does.
fake agentv-screen '
status="$STATE/screen.json"
[[ -f $STATE/no-tv ]] && exit 2
set_front() { jq --arg role "$1" --arg class "$2" ".front = {role: \$role, class: \$class, workspace: \"1\", fullscreen: 2}" "$status" >"$status.new" && mv "$status.new" "$status"; }
case "$1" in
  status)
    pid=$(jq -r ".apps[] | select(.role == \"home\") | .pid" "$status")
    if ! kill -0 "$pid" 2>/dev/null; then
      jq ".apps = [{role: \"home\", pid: 4242}] | .home_restarts += 1" "$status" >"$status.new" && mv "$status.new" "$status"
    fi
    cat "$status" ;;
  frames) cat "$STATE/frames.json" ;;
  keys) cat "$STATE/keys.json" ;;
  sounds) cat "$STATE/sounds.json" ;;
  open) if [[ $2 == steam ]]; then set_front steam gamescope; else set_front web chromium; fi; echo "{\"ok\":true}" ;;
  home) set_front home chromium; echo "{\"ok\":true}" ;;
  toast) jq ".layers += [\"agentv-toast\"]" "$status" >"$status.new" && mv "$status.new" "$status"; echo "{\"ok\":true}" ;;
  close) echo "{\"ok\":true}" ;;
  # An installed app opens, and the daemon gets its playback, unless the
  # check says it does not.
  app)
    cp -r "$AGENTV_STATE/apps/$2" "$STATE/seen-app"
    jq -c ".[\"$2\"]" "$AGENTV_STATE/apps/installed.json" >"$STATE/seen-record"
    [[ -f $STATE/no-ledger ]] || echo "{\"ok\":true,\"rows\":[{\"viewer_id\":\"radomir\",\"title\":\"agentv selftest\",\"season\":1,\"episode\":1,\"position_s\":3}]}" >"$STATE/ledger"
    echo "{\"ok\":true}" ;;
  quit) echo "$2" >>"$STATE/quit"; echo "{\"ok\":true}" ;;
esac'
fake pgrep 'exit 1'
fake systemctl '
case "$*" in
  "--user show-environment") echo WAYLAND_DISPLAY=wayland-1 ;;
  *) exit 3 ;;
esac'
# A terminal opened in the session: the daemon keeps it out of sight.
fake foot '
jq ".windows += [{title: \"agentv selftest\", workspace: \"special:agentv-held\", front: false}]" "$STATE/screen.json" >"$STATE/screen.json.new" && mv "$STATE/screen.json.new" "$STATE/screen.json"
exec sleep 30'
fake steam 'exit 0'
fake omarchy-cmd-present 'type -P "$1" >/dev/null'
# The virtual input device, and the screen daemon's journal.
fake agentv-input 'echo "$*" >>"$STATE/input.log"'
fake journalctl 'cat "$STATE/journal" 2>/dev/null || true'

tv() {
  healthy
  # Omarchy's own autologin to its desktop, kept on an encrypted disk, comes
  # before AgenTV's in name order.
  printf '[Autologin]\nUser=radomir\nSession=omarchy.desktop\n' >"$SCRATCH/sddm.conf.d/autologin.conf"
  printf '[Autologin]\nUser=radomir\nSession=agentv.desktop\nRelogin=true\n' >"$SCRATCH/sddm.conf.d/zz-agentv-autologin.conf"
  sleep 300 &
  home_pid=$!
  disown "$home_pid"
  jq -n --argjson pid "$home_pid" '{ok: true, front: {role: "home", class: "chromium", workspace: "1", fullscreen: 2},
    windows: [], apps: [{role: "home", pid: $pid}], home_restarts: 0,
    monitors: [{name: "HDMI-A-1", width: 1920, height: 1080, refresh_rate: 60}], layers: [], tv: "on"}' >"$state/screen.json"
  echo '{"ok": true, "frames": 301, "fps": 60, "worst_ms": 17.1, "slow_frames": 0}' >"$state/frames.json"
  echo '{"ok": true, "keys": ["ArrowRight", "ArrowLeft"]}' >"$state/keys.json"
  echo '{"ok": true, "on": true, "keys": 30, "played": ["move", "move"], "worst_ms": 1.4, "closest_moves_ms": 61, "output_ms": 21, "audio": "running"}' >"$state/sounds.json"
  printf '%s\n' \
    "2026-10-24T21:00:02+0200 nuc agentv-screen[812]: the TV went off; pausing" \
    "2026-10-24T21:02:02+0200 nuc agentv-screen[812]: the TV has been off for a while; closing every app" \
    "2026-10-24T21:03:10+0200 nuc agentv-screen[812]: the TV came back on" >"$state/journal"
  rm -f "$state/input.log"
  echo '{"ok": true, "welcome_shown": true, "screen": "home"}' >"$state/health"
  mkdir -p "$SCRATCH/var/chromium/Default"
  echo '{"credentials_enable_service": false, "credentials_enable_autosignin": false, "autofill": {"profile_enabled": false, "credit_card_enabled": false},
    "translate": {"enabled": false}, "profile": {"default_content_setting_values": {"notifications": 2}}}' >"$SCRATCH/var/chromium/Default/Preferences"
  mkdir -p "$SCRATCH/var/chromium/WidevineCdm/4.10.2891.0"
  echo '{"version": "4.10.2891.0"}' >"$SCRATCH/var/chromium/WidevineCdm/4.10.2891.0/manifest.json"
}

run1() {
  env PATH="$fakes:$PATH" STATE="$state" AGENTV_PATH="$SCRATCH/agentv" AGENTV_SDDM_CONF="$SCRATCH/sddm.conf" \
    AGENTV_SCREEN="$fakes/agentv-screen" AGENTV_INPUT="$fakes/agentv-input" AGENTV_STATE="$SCRATCH/var" "$BASH" "$selftest" "$@" >"$SCRATCH/out" 2>&1
}

tv
run1 || fail "a box in the TV session passes stage 1's checks" "$(cat "$SCRATCH/out")"
for line in \
  "pass S1.1 SDDM logs radomir in to the TV session, and back in after every log-out" \
  "pass S1.1 the TV session is on, with the home screen in front, full screen" \
  "pass S1.1 nothing of Omarchy's desktop runs in the TV session" \
  "pass S1.2 the services' Chromium has its Widevine module (4.10.2891.0)" \
  "manual S1.2 sign in with agentv screen open" \
  "pass S1.5 the home screen draws at 60 fps on a 60 Hz screen, with no frame over 25 ms" \
  "pass S1.5 a web app came in front in" \
  "pass S1.5 a toast showed over the app in front" \
  "pass S1.5 the home screen came back in front in" \
  "pass S1.5 Steam came in front in its own gamescope in" \
  "manual S1.5 watch:" \
  "pass S1.6 a new window stayed out of sight, and the home screen stayed in front" \
  "pass S1.6 the home screen came back in front" \
  "pass S1.7 the services' Chromium has saving passwords, address and card autofill, translate and site notifications off" \
  "manual S1.7 sign in to a streaming service again" \
  "pass S2.8 the box reads the TV as on" \
  "manual S2.8 play an episode, then turn the TV off" \
  "manual S2.8 seen at 2026-10-24T21:00:02+0200: the TV went off; pausing" \
  "manual S2.8 seen at 2026-10-24T21:03:10+0200: the TV came back on" \
  "pass S2.9 a key on the virtual input device reaches the home screen" \
  "manual S2.9 with the TV back on" \
  "pass S2.10 with the focus gliding, tiles lifting under the mouse and a page sliding in and out, the home screen drew at 60 fps on a 60 Hz screen, with no frame over 25 ms" \
  "manual S2.10 watch:" \
  "pass S2.11 each UI sound started within 1.4 ms of its key reaching the page, inside one frame; the audio output adds about 21 ms" \
  "pass S2.11 a held arrow played a move sound at most every 60 ms (the closest two: 61 ms)" \
  "manual S2.11 listen:" \
  "pass S2.15 Home put the home screen in front in" \
  "pass S2.15 choosing the app again brought the same window back in" \
  "manual S2.15 with an episode playing" \
  "manual S2.16 over a playing app"; do
  grep -qF "$line" "$SCRATCH/out" || fail "it says: $line" "$(cat "$SCRATCH/out")"
done
[[ $(tail -n 1 "$SCRATCH/out") == "S1.1 pass, S1.2 pass, S1.5 pass, S1.6 pass, S1.7 pass, S2.8 pass, S2.9 pass, S2.10 pass, S2.11 pass, S2.15 pass, S2.16 pass" ]] ||
  fail "with no id it runs stages 1 and 2, and manual lines don't fail them" "$(cat "$SCRATCH/out")"
# The keys, the pointer and the held arrows went through the input device.
for sent in "key right" "key i" "move -4000 -4000" "key down" "hold down 1.5"; do
  grep -qxF "$sent" "$state/input.log" || fail "it sent: $sent" "$(cat "$state/input.log")"
done
kill "$home_pid" 2>/dev/null || true
pass "stages 1 and 2 pass in a healthy TV session, with manual lines for what needs eyes and ears"

tv
run1 S2 || fail "S2 runs stage 2's checks" "$(cat "$SCRATCH/out")"
[[ $(tail -n 1 "$SCRATCH/out") == "S2.8 pass, S2.9 pass, S2.10 pass, S2.11 pass, S2.15 pass, S2.16 pass" ]] ||
  fail "S2 runs only stage 2's checks" "$(cat "$SCRATCH/out")"
kill "$home_pid" 2>/dev/null || true
pass "agentv selftest S2 runs stage 2's checks"

tv
echo '{"credentials_enable_service": true}' >"$SCRATCH/var/chromium/Default/Preferences"
jq '.tv = "off"' "$state/screen.json" >"$state/screen.json.new" && mv "$state/screen.json.new" "$state/screen.json"
echo '{"ok": true, "keys": []}' >"$state/keys.json"
echo '{"ok": true, "fps": 52.3, "slow_frames": 4, "worst_ms": 48}' >"$state/frames.json"
echo '{"ok": true, "on": true, "keys": 30, "played": ["move"], "worst_ms": 40.2, "closest_moves_ms": 30, "output_ms": 21, "audio": "running"}' >"$state/sounds.json"
! run1 S1.7 S2.8 S2.9 S2.10 S2.11 || fail "prompts on, a TV read as off, lost keys, dropped frames and slow sounds fail"
for line in \
  "fail S1.7 the services' Chromium still has some of its own prompts on; agentv update and a reboot turn them off" \
  "fail S2.8 the box reads the TV as off while it's on" \
  "fail S2.9 the home screen didn't get the keys sent" \
  "fail S2.10 with the focus gliding, tiles lifting and a page sliding, the home screen drew at 52.3 fps on a 60 Hz screen, with 4 frames over 25 ms (worst 48 ms)" \
  "fail S2.11 a UI sound started 40.2 ms after its key reached the page, more than a frame" \
  "fail S2.11 two move sounds played 30 ms apart, closer than 60 ms"; do
  grep -qF "$line" "$SCRATCH/out" || fail "it says: $line" "$(cat "$SCRATCH/out")"
done
echo '{"ok": true, "on": false, "keys": 30, "played": [], "worst_ms": null, "closest_moves_ms": null}' >"$state/sounds.json"
! run1 S2.11 || fail "UI sounds turned off fail S2.11"
grep -qF "fail S2.11 Settings → Sound has the UI sounds off" "$SCRATCH/out" || fail "it says the sounds are off" "$(cat "$SCRATCH/out")"
[[ $(grep -c "^fail S2.11" "$SCRATCH/out") == 1 ]] || fail "sounds off is said once, with nothing more to measure" "$(cat "$SCRATCH/out")"
echo '{"ok": false, "error": "the home screen isn'"'"'t running"}' >"$state/sounds.json"
! run1 S2.11 || fail "a measurement that doesn't come back fails S2.11"
grep -qF "fail S2.11 couldn't measure the UI sounds: the home screen isn't running" "$SCRATCH/out" || fail "it says why it couldn't measure" "$(cat "$SCRATCH/out")"
# TV setup not done yet: the welcome page has no tiles or sounds to measure.
echo '{"ok": true, "welcome_shown": true, "screen": "welcome"}' >"$state/health"
! run1 S2.10 S2.11 || fail "S2.10 and S2.11 fail before TV setup is done"
[[ $(grep -c "^fail S2.1[01] the TV is still on its setup welcome page; finish TV setup, or run agentv setup skip" "$SCRATCH/out") == 2 ]] ||
  fail "S2.10 and S2.11 say TV setup isn't done" "$(cat "$SCRATCH/out")"
kill "$home_pid" 2>/dev/null || true
pass "S1.7 and stage 2's checks fail on what they measure, and say what they saw"

tv
rm "$SCRATCH/sddm.conf.d/zz-agentv-autologin.conf"
touch "$state/no-tv"
! run1 S1.1 || fail "a box not on the TV session fails S1.1"
grep -q "^fail S1.1 SDDM logs in to omarchy.desktop" "$SCRATCH/out" || fail "it says where SDDM logs in" "$(cat "$SCRATCH/out")"
grep -q "^fail S1.1 the TV session isn't on here" "$SCRATCH/out" || fail "it says the TV session isn't on" "$(cat "$SCRATCH/out")"
kill "$home_pid" 2>/dev/null || true
pass "S1.1 fails on a box that isn't on the TV session, and says how to get there"

tv
echo '{"ok": true, "fps": 41.5, "slow_frames": 12}' >"$state/frames.json"
rm -rf "$SCRATCH/var/chromium/WidevineCdm"
rm -f "$fakes/steam"
! run1 S1.2 S1.5 || fail "a slow home screen, no Widevine and no Steam fail"
grep -q "^fail S1.2 the services' Chromium has no Widevine module yet" "$SCRATCH/out" || fail "it says Widevine is missing" "$(cat "$SCRATCH/out")"
grep -q "^fail S1.5 the home screen draws at 41.5 fps on a 60 Hz screen, with 12 frames over 25 ms" "$SCRATCH/out" ||
  fail "it says the home screen is slow" "$(cat "$SCRATCH/out")"
grep -q "^fail S1.5 Steam isn't installed" "$SCRATCH/out" || fail "it says Steam isn't installed" "$(cat "$SCRATCH/out")"
kill "$home_pid" 2>/dev/null || true
pass "S1.2 and S1.5 fail without Widevine, on dropped frames and without Steam, and say what to do"

# --- Stage 3: the checks written in TypeScript --------------------------------

# A stand-in for daemon/weather-check.ts: it says what it was asked to, as
# the real one does after comparing the tile with MET Norway.
mkdir -p "$SCRATCH/agentv/daemon"
cat >"$SCRATCH/agentv/daemon/weather-check.ts" <<'CHECK'
const id = process.argv[2];
if (process.env.STATE && require("node:fs").existsSync(`${process.env.STATE}/weather-off`)) {
  console.log(`fail ${id} the tile shows cloudy for amsterdam (52.37, 4.9), but MET says rain`);
} else {
  console.log(`pass ${id} the tile matches MET for amsterdam (52.37, 4.9)`);
  console.log(`manual ${id} on yr.no, amsterdam's forecast matches`);
}
CHECK
run1 S3 || fail "S3 runs stage 3's checks" "$(cat "$SCRATCH/out")"
for line in "pass S3.8 the tile matches MET for amsterdam (52.37, 4.9)" "manual S3.8 on yr.no" "pass S3.9 the tile matches MET" "manual S3.9 on yr.no"; do
  grep -qF "$line" "$SCRATCH/out" || fail "it says: $line" "$(cat "$SCRATCH/out")"
done
[[ $(tail -n 1 "$SCRATCH/out") == "S3.3 pass, S3.8 pass, S3.9 pass" ]] || fail "S3 runs only stage 3's checks" "$(cat "$SCRATCH/out")"
touch "$state/weather-off"
! run1 S3.8 || fail "a tile that doesn't match MET fails S3.8"
grep -qF "fail S3.8 the tile shows cloudy for amsterdam (52.37, 4.9), but MET says rain" "$SCRATCH/out" || fail "it says what didn't match" "$(cat "$SCRATCH/out")"
printf 'process.exit(3);\n' >"$SCRATCH/agentv/daemon/weather-check.ts"
! run1 S3.9 || fail "a check that says nothing fails"
grep -qF "fail S3.9 daemon/weather-check.ts said nothing" "$SCRATCH/out" || fail "it says the check said nothing" "$(cat "$SCRATCH/out")"
pass "agentv selftest S3 runs the weather checks and passes on what they say"

# --- S3.3: a ledger row within 10 s ---------------------------------------------

tv
mkdir -p "$SCRATCH/var/apps"
echo '{"agentv.sample": {"id": "agentv.sample", "tier": "official"}}' >"$SCRATCH/var/apps/installed.json"
run1 S3.3 || fail "S3.3 passes when the row comes" "$(cat "$SCRATCH/out")"
grep -qE "^pass S3.3 a ledger row appeared [0-9]+ ms after the app opened: radomir, agentv selftest S1 E1 at 3 s$" "$SCRATCH/out" ||
  fail "it says how soon the row came, and what it says" "$(cat "$SCRATCH/out")"
grep -q "^manual S3.3 a second viewer" "$SCRATCH/out" || fail "it says what waits for profiles" "$(cat "$SCRATCH/out")"
# The stand-in was a real app while it was there, and is gone with its rows.
AGENTV_PATH="$ROOT" "$ROOT/bin/agentv-app-validate" --local "$state/seen-app" >/dev/null || fail "the stand-in passes the app contract's checks"
[[ $(jq -r .tier "$state/seen-record") == local ]] || fail "the stand-in was installed as a local app" "$(cat "$state/seen-record")"
[[ ! -e $SCRATCH/var/apps/local.selftest-player ]] || fail "the stand-in is removed after"
[[ $(jq -c 'keys' "$SCRATCH/var/apps/installed.json") == '["agentv.sample"]' ]] || fail "installed.json is as it was" "$(cat "$SCRATCH/var/apps/installed.json")"
grep -q -- "-X DELETE .*api/ledger?app=local.selftest-player" "$state/curl.log" || fail "its rows are forgotten" "$(cat "$state/curl.log")"
grep -qx local.selftest-player "$state/quit" || fail "the stand-in is closed"
kill "$home_pid" 2>/dev/null || true
pass "S3.3 times a ledger row after a stand-in player opens, then removes it and its rows"

tv
rm -f "$state/ledger"
touch "$state/no-ledger"
! AGENTV_LEDGER_WAIT_MS=1500 run1 S3.3 || fail "no ledger row fails S3.3"
grep -q "^fail S3.3 no ledger row appeared within 1.5 s of the app opening" "$SCRATCH/out" || fail "it says no row came" "$(cat "$SCRATCH/out")"
[[ ! -e $SCRATCH/var/apps/local.selftest-player ]] || fail "the stand-in is removed after a failure too"
rm -f "$state/no-ledger"
kill "$home_pid" 2>/dev/null || true
pass "S3.3 fails when no row comes, and still cleans up"
