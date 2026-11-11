echo "Home's Chromium keeps no passwords: forget any it saved before its prompts went off"

# Home's Chromium ran without AgenTV's settings until now, so it offered to
# save what was typed into a password field on home (a key, the Wi-Fi's
# password) and may have kept it. The screen daemon turns the offer off at
# each start of home from here on (agentv-chromium-prefs); this throws away
# what was saved before. Home runs while this does and holds the files open,
# so they're gone for good once the update restarts the TV's session, which
# it does next.
profile=${AGENTV_CHROMIUM_HOME_STATE:-/var/lib/agentv/chromium-home}
rm -f "$profile/Default/Login Data" "$profile/Default/Login Data-journal" \
  "$profile/Default/Login Data For Account" "$profile/Default/Login Data For Account-journal"
