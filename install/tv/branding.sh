# AgenTV's logo on the screensaver and About, through Omarchy's branding
# files, and on the boot splash and the login screen, through Omarchy's own
# omarchy plymouth set (ADR-021). Omarchy's own commands, such as omarchy
# branding screensaver reset, still bring its logo back.

# The screensaver and About first, so a splash that fails can't stop them.
# The folder is made as the owner, so nothing in their home ends up root's.
branding_dir="$AGENTV_OWNER_HOME/.config/omarchy/branding"
runuser -u "$AGENTV_OWNER" -- mkdir -p "$branding_dir"
for art in screensaver about; do
  install -m 644 -o "$AGENTV_OWNER" -g "$AGENTV_OWNER" "$AGENTV_PATH/branding/logo.txt" "$branding_dir/$art.txt"
done

# The splash takes the colours of the owner's current Omarchy theme, Tokyo
# Night unless they've changed it. Omarchy keeps it under ~/.local/state.
colors="$AGENTV_OWNER_HOME/.local/state/omarchy/current/theme/colors.toml"
theme_color() {
  local value=""
  [[ -f $colors ]] && value=$(sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"\(#[0-9a-fA-F]\{6\}\)\".*/\1/p" "$colors" | head -n 1)
  echo "${value:-$2}"
}
background=$(theme_color background '#1a1b26')
foreground=$(theme_color foreground '#c0caf5')

# omarchy plymouth set won't run as root. It runs as a user, opens the logo
# as that user, and asks sudo for its privileged steps: a root bash that
# publishes the theme, then plymouth-set-default-theme and a rebuild of the
# boot image. First boot has nobody to type a password. A rule in
# /etc/sudoers.d used to cover it, for every process of the owner's. Now
# root lends this one call a sudo only it can use (bin/agentv-sudo-lend):
# the stand-in for sudo is alone in a folder of root's, first in the call's
# PATH. The call gets a clean environment, so nothing of the owner's runs.
sudo_dir=$(mktemp -d "${AGENTV_RUN_DIR:-/run}/agentv-sudo.XXXXXX")
trap 'rm -rf "$sudo_dir"' EXIT
chmod 755 "$sudo_dir"
ln -s "$(command -v agentv-sudo-shim)" "$sudo_dir/sudo"
agentv-sudo-lend --fd 200 -- runuser -u "$AGENTV_OWNER" -- env -i HOME="$AGENTV_OWNER_HOME" USER="$AGENTV_OWNER" LOGNAME="$AGENTV_OWNER" \
  PATH="$sudo_dir:${AGENTV_SYSTEM_PATH:-/usr/local/sbin:/usr/local/bin:/usr/bin}" OMARCHY_PATH="$OMARCHY_PATH" AGENTV_SUDO_FD=200 \
  omarchy-plymouth-set "$background" "$foreground" "$AGENTV_PATH/branding/plymouth-logo.png" </dev/null
rm -rf "$sudo_dir"
