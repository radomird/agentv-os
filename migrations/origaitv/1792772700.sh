# The TV runs in OrigaiTV's own session now, not inside Omarchy's desktop
# (ADR-031). Boxes installed before it move over at their next start: SDDM
# logs in to the TV session and back in after every log-out, the home screen
# gets a Chromium profile of its own, Omarchy's desktop gets Back to TV on
# Super+Ctrl+Home, and its post-boot hook stops opening the TV there. New
# boxes get all of this at first boot.
sudo origaitv-session-setup "$(id -un)"
mkdir -p "$HOME/.config/omarchy/hooks/post-boot.d"
install -m 644 "$ORIGAITV_PATH/config/omarchy/hooks/post-boot.d/origaitv" "$HOME/.config/omarchy/hooks/post-boot.d/origaitv"
origaitv-desktop-hook --install
