# The box plays at full volume, so the TV's remote sets how loud it is
# (S2.19). As the owner, since it's their own sound settings.
runuser -u "$AGENTV_OWNER" -- env HOME="$AGENTV_OWNER_HOME" agentv-audio-default
