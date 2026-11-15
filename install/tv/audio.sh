# The box plays at full volume, so the TV's remote sets how loud it is
# (S2.19). As the owner, since it's their own sound settings.
runuser -u "$ORIGAITV_OWNER" -- env HOME="$ORIGAITV_OWNER_HOME" origaitv-audio-default
