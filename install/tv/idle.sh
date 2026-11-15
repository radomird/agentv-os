# No password on the TV after it's been idle, and no suspend in Omarchy's menu
# (ADR-009, ADR-029). As the owner, since it's their own shell settings.
runuser -u "$ORIGAITV_OWNER" -- env HOME="$ORIGAITV_OWNER_HOME" OMARCHY_PATH="$OMARCHY_PATH" origaitv-tv-idle
