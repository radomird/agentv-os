# The home screen takes its colours from the Omarchy theme (ADR-012). Omarchy
# renders the templates in the owner's ~/.config/omarchy/themed/ on every
# theme change, so OrigaiTV's is linked there, and stays current with the
# package. The theme-set hook (hooks.sh) hands the result to the TV.
target="$ORIGAITV_OWNER_HOME/.config/omarchy/themed/launcher.css.tpl"
runuser -u "$ORIGAITV_OWNER" -- mkdir -p "${target%/*}"
runuser -u "$ORIGAITV_OWNER" -- ln -sfn "$ORIGAITV_PATH/config/omarchy/themed/launcher.css.tpl" "$target"
