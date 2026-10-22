# The folders TV setup and the kiosk use. Chromium's profile, which will hold
# the household's sign-ins, belongs to the owner and nobody else.
install -d -m 755 /var/lib/agentv
install -d -m 700 -o "$AGENTV_OWNER" -g "$AGENTV_OWNER" /var/lib/agentv/chromium
