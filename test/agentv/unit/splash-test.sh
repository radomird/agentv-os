#!/bin/bash

# Guards bin/agentv-splash: AgenTV's logo goes back over Omarchy's splash
# after a package replaced it, and the boot image is rebuilt, except inside
# the installer's chroot, where the installer builds it (ADR-029).

# shellcheck disable=SC2016 # the fakes' bodies are run later, by the script under test
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

bin="$SCRATCH/bin"
theme="$SCRATCH/theme"
calls="$SCRATCH/calls"
mkdir -p "$bin"
fake_agentv_path "$SCRATCH/agentv"
mkdir -p "$SCRATCH/agentv/branding"
printf 'agentv logo' >"$SCRATCH/agentv/branding/plymouth-logo.png"

fake() {
  printf '#!/bin/bash\n%s\n' "$2" >"$bin/$1"
  chmod +x "$bin/$1"
}

fake systemd-detect-virt '[[ -f $CHROOT ]]'
fake limine-mkinitcpio 'echo limine-mkinitcpio >>"$CALLS"'
fake omarchy-cmd-present 'command -v "$1" >/dev/null'

# splash [chroot]: Omarchy's logo in the theme, then the script.
splash() {
  rm -rf "${theme:?}" "${calls:?}" "${SCRATCH:?}/chroot"
  mkdir -p "$theme"
  printf 'omarchy logo' >"$theme/logo.png"
  [[ ${1:-} == chroot ]] && touch "$SCRATCH/chroot"
  env PATH="$bin:$PATH" CALLS="$calls" CHROOT="$SCRATCH/chroot" \
    AGENTV_PATH="$SCRATCH/agentv" AGENTV_SPLASH_THEME="$theme" \
    "$BASH" "$ROOT/bin/agentv-splash" >"$SCRATCH/out" 2>&1
}

splash || fail "it runs" "$(cat "$SCRATCH/out")"
cmp -s "$theme/logo.png" "$SCRATCH/agentv/branding/plymouth-logo.png" || fail "AgenTV's logo is back"
[[ $(cat "$calls") == limine-mkinitcpio ]] || fail "the boot image is rebuilt"
pass "after a package puts Omarchy's logo back, AgenTV's returns and the boot image is rebuilt"

splash chroot || fail "it runs in the installer's chroot" "$(cat "$SCRATCH/out")"
cmp -s "$theme/logo.png" "$SCRATCH/agentv/branding/plymouth-logo.png" || fail "AgenTV's logo goes in during the install"
[[ ! -f $calls ]] || fail "the installer builds the boot image itself"
pass "in the installer's chroot it only puts the logo in"

splash
rm -f "$calls"
env PATH="$bin:$PATH" CALLS="$calls" CHROOT="$SCRATCH/chroot" \
  AGENTV_PATH="$SCRATCH/agentv" AGENTV_SPLASH_THEME="$theme" "$BASH" "$ROOT/bin/agentv-splash" >/dev/null 2>&1
[[ ! -f $calls ]] || fail "an unchanged splash isn't rebuilt"
rm -rf "$theme"
env PATH="$bin:$PATH" CALLS="$calls" CHROOT="$SCRATCH/chroot" \
  AGENTV_PATH="$SCRATCH/agentv" AGENTV_SPLASH_THEME="$theme" "$BASH" "$ROOT/bin/agentv-splash" >/dev/null 2>&1 ||
  fail "no theme yet is fine"
[[ ! -e $theme ]] || fail "it makes no theme of its own"
pass "with AgenTV's logo already there, or no theme yet, it does nothing"
