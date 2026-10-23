# The TV takes its colours from the Omarchy theme now (ADR-012). Boxes
# installed before it get AgenTV's template linked where Omarchy renders the
# theme, the theme-set hook that hands the colours over, and the colours of
# the theme they have.
mkdir -p "$HOME/.config/omarchy/themed" "$HOME/.config/omarchy/hooks/theme-set.d"
ln -sfn "$AGENTV_PATH/config/omarchy/themed/launcher.css.tpl" "$HOME/.config/omarchy/themed/launcher.css.tpl"
install -m 644 "$AGENTV_PATH/config/omarchy/hooks/theme-set.d/agentv" "$HOME/.config/omarchy/hooks/theme-set.d/agentv"
agentv-theme-sync || true
