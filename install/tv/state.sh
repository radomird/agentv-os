# The folders TV setup and the TV session use. The services' Chromium
# profile, which will hold the household's sign-ins, belongs to the owner and
# nobody else; so does the home screen's, which has none (ADR-031,
# bin/origaitv-session-setup).
install -d -m 755 /var/lib/origaitv
install -d -m 700 -o "$ORIGAITV_OWNER" -g "$ORIGAITV_OWNER" /var/lib/origaitv/chromium
