# Chromium's own prompts go off in the services' profile (ADR-032): no Save
# password, autofill, translate or site notifications over the TV. The
# screen daemon sets them before each start of the services' Chromium; this
# sets them now on a box installed before.
profile=${AGENTV_CHROMIUM_STATE:-/var/lib/agentv/chromium}
if [[ -d $profile ]]; then
  agentv-chromium-prefs "$profile" || true
fi
