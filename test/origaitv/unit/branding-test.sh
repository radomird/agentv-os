#!/bin/bash

# Guards first boot's branding (install/tv/branding.sh, ADR-021): origaiTV's
# logo for the screensaver and About, and the boot splash through Omarchy's
# own omarchy plymouth set, which runs as the owner and asks sudo. No sudo
# rule is written for it (H1): root lends that one call a sudo of its own.
# The commands are stand-ins here. S0.4's image check sets a real splash.

set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/helpers.sh"

home="$SCRATCH/home"
calls="$SCRATCH/calls"
mkdir -p "$SCRATCH/bin" "$SCRATCH/origaitv/branding" "$SCRATCH/run" "$home"
echo "ORIGAITV" >"$SCRATCH/origaitv/branding/logo.txt"
echo "a logo" >"$SCRATCH/origaitv/branding/plymouth-logo.png"
ln -s "$ROOT/bin/origaitv-sudo-lend" "$ROOT/bin/origaitv-sudo-shim" "$SCRATCH/bin/"

# runuser and install, without changing whose anything is.
cat >"$SCRATCH/bin/runuser" <<SH
#!/bin/bash
echo "runuser \$*" >>"$calls"
shift 3
exec "\$@"
SH
cat >"$SCRATCH/bin/install" <<SH
#!/bin/bash
args=()
while (( \$# )); do
  case "\$1" in
    -o|-g) shift ;;
    *) args+=("\$1") ;;
  esac
  shift
done
exec /usr/bin/install "\${args[@]}"
SH
# Omarchy's command: it reads the logo as the caller and hands it to a root
# bash on its input, then asks sudo twice more, as the real one does.
cat >"$SCRATCH/bin/omarchy-plymouth-set" <<SH
#!/bin/bash
echo "omarchy-plymouth-set \$* (HOME=\$HOME, sudo is \$(command -v sudo), LEAKED=\${LEAKED:-no})" >>"$calls"
sudo /bin/bash -c 'cat >"\$1"' bash "$SCRATCH/published" <"\$3" || exit 1
sudo plymouth-set-default-theme omarchy
SH
cat >"$SCRATCH/real-sudo" <<SH
#!/bin/bash
echo "real sudo \$1 \$2" >>"$calls"
[[ \$1 == "plymouth-set-default-theme" ]] && exit 0
exec "\$@"
SH
chmod +x "$SCRATCH/bin/runuser" "$SCRATCH/bin/install" "$SCRATCH/bin/omarchy-plymouth-set" "$SCRATCH/real-sudo"

# The leaf, sourced the way Omarchy's run_logged sources it.
path="$SCRATCH/bin:$PATH"
brand() {
  : >"$calls"
  # shellcheck disable=SC2016 # the single quotes hold the command bash runs
  env LEAKED=yes PATH="$path" ORIGAITV_OWNER=someone ORIGAITV_OWNER_HOME="$home" ORIGAITV_PATH="$SCRATCH/origaitv" \
    OMARCHY_PATH=/usr/share/omarchy ORIGAITV_RUN_DIR="$SCRATCH/run" ORIGAITV_SYSTEM_PATH="$path" ORIGAITV_SUDO_REAL="$SCRATCH/real-sudo" \
    bash -eE -c 'source "$1"' bash "$ROOT/install/tv/branding.sh" >"$SCRATCH/out" 2>&1
}

brand || fail "first boot's branding runs" "$(cat "$SCRATCH/out" "$calls")"
[[ $(cat "$home/.config/omarchy/branding/screensaver.txt" "$home/.config/omarchy/branding/about.txt") == $'ORIGAITV\nORIGAITV' ]] ||
  fail "the screensaver and About get origaiTV's logo"
grep -q "^omarchy-plymouth-set #1a1b26 #c0caf5 $SCRATCH/origaitv/branding/plymouth-logo.png (HOME=$home, sudo is $SCRATCH/run/origaitv-sudo\..*/sudo, LEAKED=no)$" "$calls" ||
  fail "Omarchy's splash command runs as the owner, in Tokyo Night's colours, from a clean environment, with the lent sudo first" "$(cat "$calls")"
grep -q "^runuser -u someone -- env -i .* omarchy-plymouth-set " "$calls" || fail "H1 it starts from a clean environment" "$(cat "$calls")"
[[ $(cat "$SCRATCH/published") == "a logo" ]] || fail "the logo reaches the root step on its input, through the lent sudo" "$(cat "$SCRATCH/published" 2>&1)"
[[ $(grep -c "^real sudo" "$calls") == 2 ]] || fail "each of its sudo calls goes through" "$(cat "$calls")"
pass "S0.4 first boot sets the splash through Omarchy's own command, as the owner, with a sudo lent to that call"

[[ -z $(ls -A "$SCRATCH/run") ]] || fail "H1 the folder with the stand-in for sudo is gone after" "$(ls -A "$SCRATCH/run")"
if grep -v '^[[:space:]]*#' "$ROOT/install/tv/branding.sh" | grep -E "sudoers|NOPASSWD|visudo"; then
  fail "H1 first boot writes no sudo rule"
fi
pass "H1 first boot writes no sudo rule for the splash, and leaves nothing behind"

# A splash that fails says so, and still cleans up. First boot goes on
# without it (bin/origaitv-firstboot).
printf '#!/bin/bash\nexit 1\n' >"$SCRATCH/bin/omarchy-plymouth-set"
if brand; then fail "a splash that fails to set is reported"; fi
[[ -z $(ls -A "$SCRATCH/run") ]] || fail "H1 nothing is left behind when the splash fails"
pass "a splash that fails to set says so, and leaves nothing behind"
