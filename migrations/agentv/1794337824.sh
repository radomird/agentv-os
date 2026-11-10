# The terminal screensaver is gone: the pictures are the one idle screen
# now. A TV that had picked the terminal one forgets the pick, so its
# settings say nothing the TV no longer knows, and one still running from
# before the update stops. The rest of its settings stay as they are.
settings=${AGENTV_DAEMON_STATE:-/var/lib/private/agentv/daemon}/settings.json
if sudo test -f "$settings" && sudo jq -e 'has("ambient")' "$settings" >/dev/null 2>&1; then
  sudo sh -c 'jq "del(.ambient)" "$1" >"$1.next" && chown --reference="$1" "$1.next" && chmod --reference="$1" "$1.next" && mv "$1.next" "$1"' sh "$settings" ||
    sudo rm -f "$settings.next"
fi
pkill -f -- '--app-id=org.agentv.screensaver' 2>/dev/null || true
