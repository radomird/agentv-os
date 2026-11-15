# Omarchy's desktop is for maintenance (ADR-031). On it, Super+Ctrl+Home goes
# back to the TV, through a loader in Omarchy's toggles folder, made as the
# owner so nothing in their home ends up root's.
runuser -u "$ORIGAITV_OWNER" -- env HOME="$ORIGAITV_OWNER_HOME" ORIGAITV_PATH="$ORIGAITV_PATH" origaitv-desktop-hook --install
