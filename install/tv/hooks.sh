# origaiTV's hooks into Omarchy, in the owner's own config: its migrations after
# every update, its repository line after omarchy refresh pacman, and the TV
# at every login. A fresh install already is what the migrations migrate to,
# so they're all marked done.
for hook in "$ORIGAITV_PATH"/config/omarchy/hooks/*/origaitv; do
  name=${hook#"$ORIGAITV_PATH"/config/omarchy/hooks/}
  target="$ORIGAITV_OWNER_HOME/.config/omarchy/hooks/$name"
  # Made as the owner, so no folder in their home ends up root's.
  runuser -u "$ORIGAITV_OWNER" -- mkdir -p "${target%/*}"
  install -m 644 -o "$ORIGAITV_OWNER" -g "$ORIGAITV_OWNER" "$hook" "$target"
done

runuser -u "$ORIGAITV_OWNER" -- env HOME="$ORIGAITV_OWNER_HOME" origaitv-migrate --mark-all-done
