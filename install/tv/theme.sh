# The home screen takes its colours from the Omarchy theme (ADR-012). Omarchy
# renders the templates in the owner's ~/.config/omarchy/themed/ on every
# theme change, so AgenTV's is linked there, and stays current with the
# package. The theme-set hook (hooks.sh) hands the result to the TV.
target="$AGENTV_OWNER_HOME/.config/omarchy/themed/launcher.css.tpl"
runuser -u "$AGENTV_OWNER" -- mkdir -p "${target%/*}"
runuser -u "$AGENTV_OWNER" -- ln -sfn "$AGENTV_PATH/config/omarchy/themed/launcher.css.tpl" "$target"
