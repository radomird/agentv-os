# AgenTV's hooks into Omarchy, in the owner's own config: its migrations after
# every update, its repository line after omarchy refresh pacman, and the TV
# at every login. A fresh install already is what the migrations migrate to,
# so they're all marked done.
for hook in "$AGENTV_PATH"/config/omarchy/hooks/*/agentv; do
  name=${hook#"$AGENTV_PATH"/config/omarchy/hooks/}
  target="$AGENTV_OWNER_HOME/.config/omarchy/hooks/$name"
  # Made as the owner, so no folder in their home ends up root's.
  runuser -u "$AGENTV_OWNER" -- mkdir -p "${target%/*}"
  install -m 644 -o "$AGENTV_OWNER" -g "$AGENTV_OWNER" "$hook" "$target"
done

runuser -u "$AGENTV_OWNER" -- env HOME="$AGENTV_OWNER_HOME" agentv-migrate --mark-all-done
