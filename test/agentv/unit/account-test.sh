#!/bin/bash

# Guards install/tv/account.sh: when the USB stick's first screen made the
# account, with a password nobody knows, first boot keeps SSH to keys only.
# A box whose owner typed a password into Omarchy's installer has no note
# from the first screen, and SSH is left as Omarchy has it.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

export AGENTV_ACCOUNT_MARKER="$SCRATCH/var/lib/agentv/account.json"
export AGENTV_SSHD_NO_PASSWORD="$SCRATCH/etc/ssh/sshd_config.d/05-agentv-no-password.conf"
leaf() {
  # The way agentv-firstboot runs a leaf: sourced, under set -euo pipefail.
  bash -c 'set -euo pipefail; source "$1"' _ "$ROOT/install/tv/account.sh"
}

mkdir -p "$(dirname "$AGENTV_ACCOUNT_MARKER")"
printf '%s\n' '{"name":"agentv","passwordKnown":false}' >"$AGENTV_ACCOUNT_MARKER"
output=$(leaf)
[[ -f $AGENTV_SSHD_NO_PASSWORD ]] || fail "a box nobody knows the password of gets keys-only SSH"
if ! grep -qx 'PasswordAuthentication no' "$AGENTV_SSHD_NO_PASSWORD" ||
  ! grep -qx 'KbdInteractiveAuthentication no' "$AGENTV_SSHD_NO_PASSWORD"; then
  fail "SSH asks for no password, in either of its ways" "$(cat "$AGENTV_SSHD_NO_PASSWORD")"
fi
[[ $(stat -c %a "$AGENTV_SSHD_NO_PASSWORD") == 644 ]] || fail "sshd can read its drop-in"
[[ $output == *"SSH takes keys only"* ]] || fail "the first boot log says why" "$output"
pass "a box nobody knows the password of gets keys-only SSH"

leaf >/dev/null
[[ $(grep -c 'PasswordAuthentication' "$AGENTV_SSHD_NO_PASSWORD") == 1 ]] || fail "running it again changes nothing"
pass "running it again changes nothing"

printf '%s\n' '{"name":"agentv","passwordKnown":true}' >"$AGENTV_ACCOUNT_MARKER"
leaf >/dev/null
[[ ! -e $AGENTV_SSHD_NO_PASSWORD ]] || fail "once a password is set, SSH is as Omarchy has it"
pass "once a password is set, SSH is as Omarchy has it"

rm -f "$AGENTV_ACCOUNT_MARKER"
leaf >/dev/null
[[ ! -e $AGENTV_SSHD_NO_PASSWORD ]] || fail "a box installed through Omarchy's own installer is left alone"
pass "a box installed through Omarchy's own installer is left alone"

grep -qF "run_logged \"\$AGENTV_INSTALL/account.sh\"" "$ROOT/bin/agentv-firstboot" ||
  fail "first boot runs it"
pass "first boot runs it"
