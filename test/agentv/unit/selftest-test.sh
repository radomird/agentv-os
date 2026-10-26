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
# The daemon: /health, the ledger (S3.3) and a tile (S3.10).
fake curl '
echo "$*" >>"$STATE/curl.log"
if [[ $* == *"-X DELETE"* ]]; then echo "{\"ok\":true}"
elif [[ $* == *api/apps/*/package* ]]; then cat "$STATE/package" 2>/dev/null || echo "{\"ok\":false}"
elif [[ $* == *api/apps/*/profiles* ]]; then cat "$STATE/profiles" 2>/dev/null || echo "{\"ok\":false}"
elif [[ $* == *api/viewer* ]]; then cat "$STATE/viewer" 2>/dev/null || echo "{\"ok\":true,\"viewer\":{\"id\":\"radomir\",\"role\":\"adult\"}}"
# A player app playing since the check opened it (S3.2): its row moves on.
elif [[ $* == *api/ledger*app=local.player* && -f $STATE/playing ]]; then
  echo "{\"ok\":true,\"rows\":[{\"title\":\"Spring\",\"season\":1,\"episode\":2,\"position_s\":$(( $(date +%s) - $(cat "$STATE/playing") + 60 )),\"updated_at\":\"$(date -u +%Y-%m-%dT%H:%M:%S).123Z\"}]}"
elif [[ $* == *api/ledger* ]]; then cat "$STATE/ledger" 2>/dev/null || echo "{\"ok\":true,\"rows\":[]}"
elif [[ $* == *api/tile/* ]]; then cat "$STATE/tile" 2>/dev/null || echo "{\"ok\":true,\"tile\":null}"
elif [[ $* == *api/pin* ]]; then cat "$STATE/pin" 2>/dev/null || echo "{\"ok\":true,\"set\":false}"
elif [[ $* == *api/updates/tonight* ]]; then cat "$STATE/tonight-code" 2>/dev/null || echo 403
elif [[ $* == *api/key* ]]; then cat "$STATE/key" 2>/dev/null || echo "{\"ok\":true,\"set\":false}"
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
  # check says it does not. The player app (S3.2, S3.4) plays an item from
  # now, and opens with what the service profile step did.
  app)
    if [[ $2 == local.player ]]; then
      [[ -n ${3:-} ]] && date +%s >"$STATE/playing"
      jq --arg profile "$(cat "$STATE/profile-outcome" 2>/dev/null)" ".open = [{id: \"local.player\", role: \"web\", profile: \$profile}]" "$status" >"$status.new" && mv "$status.new" "$status"
      echo "{\"ok\":true}"
      exit 0
    fi
    cp -r "$AGENTV_STATE/apps/$2" "$STATE/seen-app"
    jq -c ".[\"$2\"]" "$AGENTV_STATE/apps/installed.json" >"$STATE/seen-record"
    [[ -f $STATE/no-ledger ]] || echo "{\"ok\":true,\"rows\":[{\"viewer_id\":\"radomir\",\"title\":\"agentv selftest\",\"season\":1,\"episode\":1,\"position_s\":3}]}" >"$STATE/ledger"
    echo "{\"ok\":true}" ;;
  quit) echo "$2" >>"$STATE/quit"; echo "{\"ok\":true}" ;;
  settings) echo "$2" >>"$STATE/settings"; echo "{\"ok\":true}" ;;
  # The sound output (S2.19): at 100%, or at what the check sets.
  audio) cat "$STATE/audio.json" 2>/dev/null || echo "{\"ok\":true,\"output\":\"hdmi\",\"outputs\":[{\"name\":\"hdmi\",\"description\":\"LG TV (HDMI)\"}],\"volume\":1,\"expected\":1}" ;;
esac'
fake pgrep 'exit 1'
fake systemctl '
case "$*" in
  "--user show-environment") echo WAYLAND_DISPLAY=wayland-1 ;;
  # How long the units may take to stop (S2.18), or one that waits.
  *"show -p TimeoutStopUSec --value agentv-"*)
    if [[ -f $STATE/slow-stop && $* == *agentv-screen* ]]; then echo "1min 30s"; else echo 5s; fi ;;
  "is-active --quiet agentv-key.path") [[ ! -f $STATE/no-key-path ]] ;;
  *) exit 3 ;;
esac'
# polkit, with AgenTV's power rule there unless it isn't (S2.18).
fake pkcheck '[[ ! -f $STATE/no-power-rule ]]'
fake omarchy-system-shutdown 'exit 0'
fake omarchy-system-reboot 'exit 0'
# A terminal opened in the session: the daemon keeps it out of sight.
fake foot '
jq ".windows += [{title: \"agentv selftest\", workspace: \"special:agentv-held\", front: false}]" "$STATE/screen.json" >"$STATE/screen.json.new" && mv "$STATE/screen.json.new" "$STATE/screen.json"
exec sleep 30'
fake steam 'exit 0'
fake omarchy-cmd-present 'type -P "$1" >/dev/null'
# The virtual input device, and the screen daemon's journal.
fake agentv-input 'echo "$*" >>"$STATE/input.log"'
# agentv app install and remove: the real ones (ADR-039), from this repo.
fake agentv-app-install 'echo "install $*" >>"$STATE/app.log"; AGENTV_PATH="$ROOT" exec "$ROOT/bin/agentv-app-install" "$@"'
fake agentv-app-remove 'echo "remove $*" >>"$STATE/app.log"; AGENTV_PATH="$ROOT" exec "$ROOT/bin/agentv-app-remove" "$@"'
# The Music app in the TV session (S3.6): a scan in the background that's
# done at the second look, its library and sources, and a player whose
# position moves on with each look, unless it's stuck.
fake agentv-music '
echo "$*" >>"$STATE/music.log"
case "$1" in
  scan)
    echo 0 >"$STATE/music-looks-scan"
    if [[ -f $STATE/music-scan ]]; then cat "$STATE/music-scan"; else echo "{\"ok\":true,\"progress\":{\"scanning\":true,\"read\":0,\"found\":0,\"albums\":0}}"; fi ;;
  progress)
    looks=$(( $(cat "$STATE/music-looks-scan") + 1 ))
    echo "$looks" >"$STATE/music-looks-scan"
    if [[ -f $STATE/music-progress ]]; then cat "$STATE/music-progress"
    elif (( looks < 2 )); then echo "{\"ok\":true,\"progress\":{\"scanning\":true,\"source\":\"nas/music\",\"read\":3,\"found\":9,\"albums\":1}}"
    else echo "{\"ok\":true,\"progress\":{\"scanning\":false,\"read\":9,\"found\":9,\"albums\":3,\"finishedAt\":\"2026-10-26T12:00:00Z\"}}"; fi ;;
  sources) cat "$STATE/music-sources" 2>/dev/null || echo "{\"ok\":true,\"sources\":[]}" ;;
  library) cat "$STATE/music-library" ;;
  play)
    shift
    [[ $1 == album ]] && shift
    jq -c --arg q "$*" "first(.albums[] | select((.title | ascii_downcase) == (\$q | ascii_downcase))) | {ok: true, playing: {kind: \"album\", key: .id, title: .title, tracks: 3}}" "$STATE/music-library" | tee "$STATE/music-playing"
    echo 0 >"$STATE/music-looks" ;;
  now)
    if [[ -f $STATE/music-playing ]]; then
      looks=$(( $(cat "$STATE/music-looks") + 1 ))
      [[ -f $STATE/music-stuck ]] && looks=1
      echo "$looks" >"$STATE/music-looks"
      jq -c --argjson looks "$looks" "{ok: true, now: {title: \"Dusk\", artist: \"Pixel Band\", album: .playing.title, albumId: .playing.key, position: (\$looks * 1.5), duration: 61, playing: true}}" "$STATE/music-playing"
    else
      echo "{\"ok\":true,\"now\":null}"
    fi ;;
  stop) rm -f "$STATE/music-playing"; echo "{\"ok\":true}" ;;
esac'
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
  rm -f "$state/input.log" "$state/music.log" "$state/music-playing" "$state/music-stuck" "$state/music-scan" "$state/music-progress" "$state/music-sources"
  # A Music library with an album on the box, one on a stick and one on a share.
  echo '{"ok": true, "albums": [
    {"id": "f1", "title": "Test Tones", "artist": "AgenTV", "source": "folder:/home/radomir/Music"},
    {"id": "u1", "title": "Night Shift", "artist": "Pixel Band", "source": "usb:/dev/sdb1"},
    {"id": "s1", "title": "Harbour Lights", "artist": "The Quays", "source": "share:smb://nas/music"}], "playlists": []}' >"$state/music-library"
  echo '{"ok": true, "welcome_shown": true, "screen": "home"}' >"$state/health"
  mkdir -p "$SCRATCH/var/chromium/Default"
  echo '{"credentials_enable_service": false, "credentials_enable_autosignin": false, "autofill": {"profile_enabled": false, "credit_card_enabled": false},
    "translate": {"enabled": false}, "profile": {"default_content_setting_values": {"notifications": 2}}}' >"$SCRATCH/var/chromium/Default/Preferences"
  mkdir -p "$SCRATCH/var/chromium/WidevineCdm/4.10.2891.0"
  echo '{"version": "4.10.2891.0"}' >"$SCRATCH/var/chromium/WidevineCdm/4.10.2891.0/manifest.json"
}

run1() {
  env PATH="$fakes:$PATH" STATE="$state" AGENTV_PATH="$SCRATCH/agentv" AGENTV_SDDM_CONF="$SCRATCH/sddm.conf" \
    AGENTV_SCREEN="$fakes/agentv-screen" AGENTV_APP="$fakes/agentv-app" ROOT="$ROOT" AGENTV_INPUT="$fakes/agentv-input" AGENTV_MUSIC="$fakes/agentv-music" AGENTV_MUSIC_WAIT_S=0 AGENTV_MUSIC_POLL_S=0 \
    AGENTV_STATE="$SCRATCH/var" "$BASH" "$selftest" "$@" >"$SCRATCH/out" 2>&1
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
  "manual S2.16 over a playing app" \
  "pass S2.18 polkit lets" \
  "pass S2.18 AgenTV's units stop within 5 s, so none holds up a restart or a shut down" \
  "pass S2.18 Omarchy's omarchy-system-shutdown and omarchy-system-reboot are there" \
  "pass S2.18 Settings opened at Power on the TV" \
  "manual S2.18 on the TV, Power is in Settings now" \
  "pass S2.19 LG TV (HDMI) plays at 100%" \
  "manual S2.19 play something"; do
  grep -qF "$line" "$SCRATCH/out" || fail "it says: $line" "$(cat "$SCRATCH/out")"
done
[[ $(tail -n 1 "$SCRATCH/out") == "S1.1 pass, S1.2 pass, S1.5 pass, S1.6 pass, S1.7 pass, S2.8 pass, S2.9 pass, S2.10 pass, S2.11 pass, S2.15 pass, S2.16 pass, S2.18 pass, S2.19 pass" ]] ||
  fail "with no id it runs stages 1 and 2, and manual lines don't fail them" "$(cat "$SCRATCH/out")"
# The keys, the pointer and the held arrows went through the input device.
for sent in "key right" "key i" "move -4000 -4000" "key down" "hold down 1.5"; do
  grep -qxF "$sent" "$state/input.log" || fail "it sent: $sent" "$(cat "$state/input.log")"
done
kill "$home_pid" 2>/dev/null || true
pass "stages 1 and 2 pass in a healthy TV session, with manual lines for what needs eyes and ears"

tv
run1 S2 || fail "S2 runs stage 2's checks" "$(cat "$SCRATCH/out")"
[[ $(tail -n 1 "$SCRATCH/out") == "S2.8 pass, S2.9 pass, S2.10 pass, S2.11 pass, S2.15 pass, S2.16 pass, S2.18 pass, S2.19 pass" ]] ||
  fail "S2 runs only stage 2's checks" "$(cat "$SCRATCH/out")"
[[ $(cat "$state/settings") == "power" ]] || fail "S2.18 opens Settings at Power" "$(cat "$state/settings" 2>/dev/null)"
kill "$home_pid" 2>/dev/null || true
pass "agentv selftest S2 runs stage 2's checks"

tv
touch "$state/no-power-rule" "$state/slow-stop"
! run1 S2.18 || fail "S2.18 fails without the power rule and with a unit that waits" "$(cat "$SCRATCH/out")"
grep -q "^fail S2.18 polkit asks .* for a password to power-off power-off-multiple-sessions reboot reboot-multiple-sessions: is 50-agentv-power.rules" "$SCRATCH/out" ||
  fail "it says polkit would ask" "$(cat "$SCRATCH/out")"
grep -qF "fail S2.18 these may hold up a shut down for longer than 5 s: agentv-screen.service (1min 30s)" "$SCRATCH/out" ||
  fail "it names the unit that would wait" "$(cat "$SCRATCH/out")"
rm -f "$state/no-power-rule" "$state/slow-stop"
kill "$home_pid" 2>/dev/null || true
pass "S2.18 fails when polkit would ask for a password or a unit would hold a shut down up"

tv
echo '{"ok":true,"output":"hdmi","outputs":[{"name":"hdmi","description":"LG TV (HDMI)"}],"volume":0.6,"expected":0.6}' >"$state/audio.json"
run1 S2.19 || fail "S2.19 passes at a level chosen in Settings" "$(cat "$SCRATCH/out")"
grep -qF "pass S2.19 LG TV (HDMI) plays at 60%, as chosen in Settings → Sound" "$SCRATCH/out" || fail "it says the level was chosen" "$(cat "$SCRATCH/out")"
echo '{"ok":true,"output":"hdmi","outputs":[{"name":"hdmi","description":"LG TV (HDMI)"}],"volume":0.4,"expected":1}' >"$state/audio.json"
! run1 S2.19 || fail "S2.19 fails at Omarchy's 40%" "$(cat "$SCRATCH/out")"
grep -qF "fail S2.19 LG TV (HDMI) plays at 40%, not the 100% it should" "$SCRATCH/out" || fail "it says what it should be" "$(cat "$SCRATCH/out")"
echo '{"ok":true,"output":null,"outputs":[],"volume":null,"expected":null}' >"$state/audio.json"
! run1 S2.19 || fail "S2.19 fails with no output" "$(cat "$SCRATCH/out")"
grep -qF "fail S2.19 there's no sound output playing" "$SCRATCH/out" || fail "it says there's no output" "$(cat "$SCRATCH/out")"
rm -f "$state/audio.json"
kill "$home_pid" 2>/dev/null || true
pass "S2.19 says the output and its volume, and fails below the level it should be or with no output"

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
echo '{"ok":true,"tile":{"headline":{"label":"continue"},"entries":[{"label":"agentv selftest","caption":"S1 E1"}]}}' >"$state/tile"
run1 S3 || fail "S3 runs stage 3's checks" "$(cat "$SCRATCH/out")"
rm -f "$state/tile"
for line in "pass S3.8 the tile matches MET for amsterdam (52.37, 4.9)" "manual S3.8 on yr.no" "pass S3.9 the tile matches MET" "manual S3.9 on yr.no"; do
  grep -qF "$line" "$SCRATCH/out" || fail "it says: $line" "$(cat "$SCRATCH/out")"
done
[[ $(tail -n 1 "$SCRATCH/out") == "S3.3 pass, S3.6 pass, S3.8 pass, S3.9 pass, S3.10 pass" ]] || fail "S3 runs only stage 3's checks" "$(cat "$SCRATCH/out")"
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
[[ $(jq -r '.source | test("/app$")' "$state/seen-record") == true ]] || fail "its record says which folder it came from" "$(cat "$state/seen-record")"
grep -qx "install --local .*/app --yes" "$state/app.log" || fail "S3.3 installs the stand-in with agentv app install --local" "$(cat "$state/app.log")"
grep -qx "remove local.selftest-player" "$state/app.log" || fail "and removes it with agentv app remove" "$(cat "$state/app.log")"
[[ ! -e $SCRATCH/var/apps/local.selftest-player ]] || fail "the stand-in is removed after"
[[ $(jq -c 'keys' "$SCRATCH/var/apps/installed.json") == '["agentv.sample"]' ]] || fail "installed.json is as it was" "$(cat "$SCRATCH/var/apps/installed.json")"
grep -q -- "-X DELETE .*api/ledger?app=local.selftest-player" "$state/curl.log" || fail "its rows are forgotten" "$(cat "$state/curl.log")"
grep -qx local.selftest-player "$state/quit" || fail "the stand-in is closed"
kill "$home_pid" 2>/dev/null || true
pass "S3.3 times a ledger row after a stand-in player opens, then removes it and its rows"

tv
echo '{"ok":true,"tile":{"headline":{"label":"continue"},"entries":[{"label":"agentv selftest","caption":"S1 E1 · 10 min left"}]}}' >"$state/tile"
run1 S3.10 || fail "S3.10 passes with a continue tile" "$(cat "$SCRATCH/out")"
grep -qF "pass S3.10 the stand-in's medium tile continues from the ledger: agentv selftest, S1 E1 · 10 min left" "$SCRATCH/out" ||
  fail "it says what the continue tile shows" "$(cat "$SCRATCH/out")"
! grep -q " S3.3 " "$SCRATCH/out" || fail "S3.10 alone says nothing about S3.3" "$(cat "$SCRATCH/out")"
echo '{"ok":true,"tile":null}' >"$state/tile"
! run1 S3.3 S3.10 || fail "no continue tile fails S3.10"
grep -q "^fail S3.10 the stand-in's medium tile isn't a continue tile" "$SCRATCH/out" || fail "it says the tile isn't a continue tile" "$(cat "$SCRATCH/out")"
[[ $(grep -c "^pass S3.3 a ledger row appeared" "$SCRATCH/out") == 1 ]] || fail "S3.3 and S3.10 share one stand-in" "$(cat "$SCRATCH/out")"
rm -f "$state/tile"
kill "$home_pid" 2>/dev/null || true
pass "S3.10 checks the stand-in's continue tile, with S3.3 or alone"

tv
rm -f "$state/ledger"
touch "$state/no-ledger"
! AGENTV_LEDGER_WAIT_MS=1500 run1 S3.3 || fail "no ledger row fails S3.3"
grep -q "^fail S3.3 no ledger row appeared within 1.5 s of the app opening" "$SCRATCH/out" || fail "it says no row came" "$(cat "$SCRATCH/out")"
[[ ! -e $SCRATCH/var/apps/local.selftest-player ]] || fail "the stand-in is removed after a failure too"
rm -f "$state/no-ledger"
kill "$home_pid" 2>/dev/null || true
pass "S3.3 fails when no row comes, and still cleans up"

# With the adult PIN set and no terminal, the install asks on the TV, where
# nobody types it here: S3.3 says so, and nothing is left behind.
tv
echo '{"ok":true,"set":true}' >"$state/pin"
: >"$state/app.log"
! run1 S3.3 S3.10 || fail "an install that isn't approved fails S3.3"
grep -q "^fail S3.3 agentv app install --local didn't install the stand-in player" "$SCRATCH/out" || fail "it says the install didn't happen" "$(cat "$SCRATCH/out")"
grep -q "^fail S3.10 agentv app install --local didn't install the stand-in player" "$SCRATCH/out" || fail "S3.10 says so too" "$(cat "$SCRATCH/out")"
[[ ! -e $SCRATCH/var/apps/local.selftest-player && $(jq -c 'keys' "$SCRATCH/var/apps/installed.json") == '["agentv.sample"]' ]] ||
  fail "nothing of the stand-in is left" "$(ls "$SCRATCH/var/apps")"
rm -f "$state/pin"
kill "$home_pid" 2>/dev/null || true
pass "S3.3 installs its stand-in only once an adult says yes, as any app install"

# --- S3.2 and S3.4: a named app's episode and its profile for children --------

mkdir -p "$SCRATCH/player"
echo '{"tv": {"capabilities": ["launch", "playback", "profiles"]}}' >"$SCRATCH/player/manifest.json"
item='{"kind":"episode","title":"spring","season":1,"episode":2}'

tv
echo "{\"ok\": true, \"dir\": \"$SCRATCH/player\"}" >"$state/package"
run1 S3.2 S3.4 || fail "with no app named, S3.2 and S3.4 say how and pass nothing" "$(cat "$SCRATCH/out")"
grep -q "^manual S3.2 name the app and a known episode: agentv selftest S3.2 --app <id> --item" "$SCRATCH/out" || fail "S3.2 says how to name them" "$(cat "$SCRATCH/out")"
grep -q "^manual S3.4 name the app: agentv selftest S3.4 --app <id>" "$SCRATCH/out" || fail "S3.4 says how to name it" "$(cat "$SCRATCH/out")"
! run1 S3.2 --item '"spring"' || fail "an item that isn't an object is a usage error"
! run1 S3.2 --app '../x' || fail "an app that isn't an id is a usage error"

rm -f "$state/playing"
run1 S3.2 --app local.player --item "$item" || fail "S3.2 passes when the episode plays and its position moves" "$(cat "$SCRATCH/out")"
grep -qE "^pass S3.2 local.player opened it through its playback.open, and its playback state read Spring S1 E2 at 6[0-2] s, then Spring S1 E2 at 6[1-9] s$" "$SCRATCH/out" ||
  fail "it says what it read, twice" "$(cat "$SCRATCH/out")"
grep -qx "local.player" "$state/quit" || fail "the app is closed first, so it opens fresh"
pass "S3.2 opens the named episode in the named app and reads a moving position from its rows"

rm -f "$state/playing"
! AGENTV_PLAYBACK_WAIT_S=3 run1 S3.2 --app local.player --item '{"kind":"episode","title":"spring","season":1,"episode":3}' || fail "another episode fails S3.2"
grep -q "^fail S3.2 local.player didn't play spring within 3 s of opening it; its newest row says Spring S1 E2 at" "$SCRATCH/out" || fail "it says what played instead" "$(cat "$SCRATCH/out")"
echo '{"tv": {"capabilities": ["launch"]}}' >"$SCRATCH/player/manifest.json"
! run1 S3.2 --app local.player --item "$item" || fail "an app without playback fails S3.2"
grep -q "^fail S3.2 local.player isn't an app on this box with playback" "$SCRATCH/out" || fail "it says it has no playback" "$(cat "$SCRATCH/out")"
echo '{"tv": {"capabilities": ["launch", "playback", "profiles"]}}' >"$SCRATCH/player/manifest.json"
pass "S3.2 fails on another episode, and on an app without playback"

run1 S3.4 --app local.player || fail "with an adult watching, S3.4 says to switch to a child" "$(cat "$SCRATCH/out")"
grep -q "^manual S3.4 switch to a child's profile on the TV or the phone, then run agentv selftest S3.4 --app local.player again" "$SCRATCH/out" || fail "it says to switch" "$(cat "$SCRATCH/out")"
echo '{"ok":true,"viewer":{"id":"v-mila","role":"child"}}' >"$state/viewer"
echo '{"ok":true,"names":["Grown","Little"],"forChildren":null}' >"$state/profiles"
! run1 S3.4 --app local.player || fail "with nothing picked for children, S3.4 fails"
grep -q "^fail S3.4 no profile is picked for children in local.player: an adult picks it in the app's details" "$SCRATCH/out" || fail "it says to pick one" "$(cat "$SCRATCH/out")"
echo '{"ok":true,"names":["Grown","Little"],"forChildren":"Little"}' >"$state/profiles"
echo selected >"$state/profile-outcome"
run1 S3.4 --app local.player || fail "S3.4 passes when the profile for children opens" "$(cat "$SCRATCH/out")"
grep -qx "pass S3.4 with a child watching, local.player opened the profile picked for children" "$SCRATCH/out" || fail "it says so" "$(cat "$SCRATCH/out")"
! grep -q "Little" "$SCRATCH/out" || fail "S3.4 never says the profile's name" "$(cat "$SCRATCH/out")"
echo "not selected" >"$state/profile-outcome"
! AGENTV_PROFILE_WAIT_S=2 run1 S3.4 --app local.player || fail "a profile that didn't open fails S3.4"
grep -qx "fail S3.4 with a child watching, local.player said: not selected" "$SCRATCH/out" || fail "it says what the screen daemon said" "$(cat "$SCRATCH/out")"
rm -f "$state/viewer" "$state/profiles" "$state/profile-outcome" "$state/playing"
kill "$home_pid" 2>/dev/null || true
pass "S3.4 checks, with a child watching, that the named app opened the profile for children, and never names it"

# --- S3.6: an album from a stick and one from a share ---------------------------

tv
run1 S3.6 || fail "S3.6 passes when both albums play" "$(cat "$SCRATCH/out")"
for line in \
  "pass S3.6 play Night Shift found the album on a USB drive (/dev/sdb1), and it plays: Dusk at 3 s" \
  "pass S3.6 play Harbour Lights found the album on a NAS share (smb://nas/music), and it plays: Dusk at 3 s" \
  "manual S3.6 listen: each album comes out of the TV's speakers"; do
  grep -qF "$line" "$SCRATCH/out" || fail "it says: $line" "$(cat "$SCRATCH/out")"
done
grep -qx "scan" "$state/music.log" || fail "it reads the sources again first" "$(cat "$state/music.log")"
[[ $(grep -c "^progress$" "$state/music.log") == 2 ]] || fail "and follows the scan's progress until it's done" "$(cat "$state/music.log")"
grep -qx "play album Night Shift" "$state/music.log" || fail "it asks for the album by name" "$(cat "$state/music.log")"
[[ $(tail -n 1 "$state/music.log") == stop ]] || fail "it stops the music after" "$(cat "$state/music.log")"
[[ $(tail -n 1 "$SCRATCH/out") == "S3.6 pass" ]] || fail "S3.6 alone runs only S3.6" "$(cat "$SCRATCH/out")"
kill "$home_pid" 2>/dev/null || true
pass "S3.6 plays an album from a USB drive and one from a share, each found by name"

tv
# The same album on the stick and the share can't show that "play" finds
# each, and with no share there's nothing to find there.
echo '{"ok": true, "albums": [
  {"id": "u1", "title": "Night Shift", "source": "usb:/dev/sdb1"},
  {"id": "u2", "title": "Harbour Lights", "source": "usb:/dev/sdb1"},
  {"id": "s1", "title": "harbour lights", "source": "share:smb://nas/music"}], "playlists": []}' >"$state/music-library"
! run1 S3.6 || fail "no album only on a share fails S3.6"
grep -qF "pass S3.6 play Night Shift found the album on a USB drive" "$SCRATCH/out" || fail "the stick's own album still passes" "$(cat "$SCRATCH/out")"
grep -qF "fail S3.6 there's no album on a NAS share whose name is only there; add a share with agentv music add-share" "$SCRATCH/out" ||
  fail "it says how to add a share" "$(cat "$SCRATCH/out")"
touch "$state/music-stuck"
! run1 S3.6 || fail "a player that doesn't move on fails S3.6"
grep -qF "fail S3.6 Night Shift from a USB drive didn't play:" "$SCRATCH/out" || fail "it says it didn't play" "$(cat "$SCRATCH/out")"
rm -f "$state/music-stuck"
# The share's album is away: it isn't picked, and root's reason shows.
echo '{"ok": true, "albums": [
  {"id": "u1", "title": "Night Shift", "source": "usb:/dev/sdb1"},
  {"id": "s1", "title": "Harbour Lights", "source": "share:smb://radomir@nas/music", "away": true}], "playlists": []}' >"$state/music-library"
echo '{"ok": true, "sources": [{"id": "share:smb://radomir@nas/music", "kind": "share", "name": "nas/music", "available": false, "error": "the NAS didn'"'"'t take that user name and password"}]}' >"$state/music-sources"
! run1 S3.6 || fail "an album that's away fails S3.6"
grep -qF "fail S3.6 there's no album on a NAS share whose name is only there (nas/music is away: the NAS didn't take that user name and password); add a share" "$SCRATCH/out" ||
  fail "it says the share is away, and why" "$(cat "$SCRATCH/out")"
if grep -qx "play album Harbour Lights" "$state/music.log"; then fail "and doesn't try to play it"; fi
echo '{"ok": false, "error": "music isn'"'"'t here"}' >"$state/music-scan"
! run1 S3.6 || fail "Music not starting a scan fails S3.6"
grep -qF "fail S3.6 Music couldn't start reading its sources: music isn't here" "$SCRATCH/out" || fail "it says Music couldn't start" "$(cat "$SCRATCH/out")"
# The NUC's empty reason: a scan that answers nothing says so.
: >"$state/music-scan"
! run1 S3.6 || fail "Music saying nothing fails S3.6"
grep -qx "fail S3.6 Music couldn't start reading its sources: Music didn't answer" "$SCRATCH/out" || fail "it says Music didn't answer, not nothing" "$(cat "$SCRATCH/out")"
rm -f "$state/music-scan"
echo '{"ok": true, "progress": {"scanning": false, "read": 4, "found": 9, "albums": 1, "error": "the folder went away"}}' >"$state/music-progress"
! run1 S3.6 || fail "a scan that stops fails S3.6"
grep -qF "fail S3.6 Music couldn't read its sources: the folder went away" "$SCRATCH/out" || fail "it says why the scan stopped" "$(cat "$SCRATCH/out")"
echo '{"ok": true, "progress": {"scanning": true, "source": "nas/music", "read": 1200, "found": 5000, "albums": 40}}' >"$state/music-progress"
! AGENTV_MUSIC_SCAN_S=0 run1 S3.6 || fail "a scan still going at the ceiling fails S3.6"
grep -qF "fail S3.6 Music was still reading its sources after 0 minutes, with 1200 of 5000 files read from nas/music and 40 albums so far. Music → sources says how far it's got" "$SCRATCH/out" ||
  fail "it says how far the scan got" "$(cat "$SCRATCH/out")"
kill "$home_pid" 2>/dev/null || true
pass "S3.6 fails with what to do when an album isn't there or is away, doesn't play, or Music doesn't answer or doesn't finish reading"

# --- Stage 4 ---------------------------------------------------------------

etc="$SCRATCH/etc"
mkdir -p "$etc"
run4() {
  AGENTV_ETC="$etc" run1 "$@"
}
fake stat 'case "$*" in "-c %a "*) cat "$STATE/env-mode" ;; "-c %U "*) cat "$STATE/env-owner" ;; esac'

run4 S4 || fail "with no pin and no key, stage 4's checks say what to do first" "$(cat "$SCRATCH/out")"
grep -qF "manual S4.5 there's no adult PIN yet: set one in Settings → Adult PIN" "$SCRATCH/out" || fail "it says to set a pin" "$(cat "$SCRATCH/out")"
grep -qF "manual S4.6 there's no key yet: add one in Settings → AI" "$SCRATCH/out" || fail "it says to add a key" "$(cat "$SCRATCH/out")"
pass "with no PIN and no key yet, S4.5 and S4.6 say what to set first"

echo '{"ok":true,"set":true,"locked":false}' >"$state/pin"
run4 S4.5 || fail "S4.5 passes when the daemon refuses without the pin" "$(cat "$SCRATCH/out")"
grep -qF "pass S4.5 with the adult PIN set, installing tonight without it is refused" "$SCRATCH/out" || fail "it says what was refused" "$(cat "$SCRATCH/out")"
{ grep -q 'api/updates/tonight' "$state/curl.log" && grep -q '"version":"selftest"' "$state/curl.log"; } || fail "it asks for a version nothing installs" "$(cat "$state/curl.log")"
echo 400 >"$state/tonight-code"
! run4 S4.5 || fail "S4.5 fails when the daemon lets it through"
grep -qF "fail S4.5 installing tonight without the PIN wasn't refused (HTTP 400)" "$SCRATCH/out" || fail "it says it wasn't refused" "$(cat "$SCRATCH/out")"
pass "S4.5 passes only when the daemon refuses a guarded request without the PIN"

echo '{"ok":true,"set":true,"provider":"claude"}' >"$state/key"
touch "$etc/env"
chmod 000 "$etc/env"
echo 600 >"$state/env-mode"
echo root >"$state/env-owner"
run4 S4.6 || fail "S4.6 passes with the key root's alone" "$(cat "$SCRATCH/out")"
grep -qF "pass S4.6 the claude key is root's alone ($etc/env, 600), and this account can't read it" "$SCRATCH/out" || fail "it says whose it is" "$(cat "$SCRATCH/out")"
echo 644 >"$state/env-mode"
! run4 S4.6 || fail "S4.6 fails when anyone can read the key"
grep -qF "fail S4.6 $etc/env is root's with mode 644, not root's with 600" "$SCRATCH/out" || fail "it says the mode" "$(cat "$SCRATCH/out")"
echo 600 >"$state/env-mode"
touch "$state/no-key-path"
! run4 S4.6 || fail "S4.6 fails without the hand-over"
grep -qF "fail S4.6 agentv-key.path isn't running" "$SCRATCH/out" || fail "it says the hand-over is off" "$(cat "$SCRATCH/out")"
rm -f "$state/no-key-path" "$etc/env"
! run4 S4.6 || fail "S4.6 fails with no env file"
pass "S4.6 passes only with the key root's alone, mode 600, and the hand-over running"
