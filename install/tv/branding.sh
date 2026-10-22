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
# Night unless they've changed it.
colors="$AGENTV_OWNER_HOME/.config/omarchy/current/theme/colors.toml"
theme_color() {
  local value=""
  [[ -f $colors ]] && value=$(sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"\(#[0-9a-fA-F]\{6\}\)\".*/\1/p" "$colors" | head -n 1)
  echo "${value:-$2}"
}
background=$(theme_color background '#1a1b26')
foreground=$(theme_color foreground '#c0caf5')

# omarchy plymouth set runs as a user and asks sudo for its one privileged
# step. First boot has nobody to type a password, and runs before the login
# screen, when nothing of the owner's is running. So the owner may run bash as
# root without a password for this one call. The rule goes right after, and
# also if anything here fails. It uses the name omarchy sudo passwordless
# uses, so Omarchy's own tmpfiles rule removes it at the next boot even if the
# power goes out halfway through.
rule="/etc/sudoers.d/99-omarchy-nopasswd-$AGENTV_OWNER"
trap 'rm -f "$rule"' EXIT
printf '%s ALL=(root) NOPASSWD: /bin/bash\n' "$AGENTV_OWNER" >"$rule"
chmod 0440 "$rule"
visudo -cqf "$rule"
runuser -u "$AGENTV_OWNER" -- env HOME="$AGENTV_OWNER_HOME" OMARCHY_PATH="$OMARCHY_PATH" \
  omarchy-plymouth-set "$background" "$foreground" "$AGENTV_PATH/branding/plymouth-logo.png"
rm -f "$rule"
