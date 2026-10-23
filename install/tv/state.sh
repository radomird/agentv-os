# The folders TV setup and the TV session use. The services' Chromium
# profile, which will hold the household's sign-ins, belongs to the owner and
# nobody else; so does the home screen's, which has none (ADR-031,
# bin/agentv-session-setup).
install -d -m 755 /var/lib/agentv
install -d -m 700 -o "$AGENTV_OWNER" -g "$AGENTV_OWNER" /var/lib/agentv/chromium
