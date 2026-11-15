# The TV takes its colours from the Omarchy theme now (ADR-012). Boxes
# installed before it get OrigaiTV's template linked where Omarchy renders the
# theme, the theme-set hook that hands the colours over, and the colours of
# the theme they have.
mkdir -p "$HOME/.config/omarchy/themed" "$HOME/.config/omarchy/hooks/theme-set.d"
ln -sfn "$ORIGAITV_PATH/config/omarchy/themed/launcher.css.tpl" "$HOME/.config/omarchy/themed/launcher.css.tpl"
install -m 644 "$ORIGAITV_PATH/config/omarchy/hooks/theme-set.d/origaitv" "$HOME/.config/omarchy/hooks/theme-set.d/origaitv"
origaitv-theme-sync || true
