# Omarchy's desktop is for maintenance (ADR-031). On it, Super+Ctrl+Home goes
# back to the TV, through a loader in Omarchy's toggles folder, made as the
# owner so nothing in their home ends up root's.
runuser -u "$AGENTV_OWNER" -- env HOME="$AGENTV_OWNER_HOME" AGENTV_PATH="$AGENTV_PATH" agentv-desktop-hook --install
