# Omarchy's desktop brings a few services a TV doesn't need. Each is one more
# thing listening on a box nobody watches, so first boot turns them off.
# They're disabled, not masked and not removed: someone who uses Omarchy's
# desktop on the box gets one back with a plain systemctl enable --now, or
# the ufw line below. Avahi stays, since the TV finds the home's servers
# with it.
#
# Safe to run again, and on a box where one of them isn't installed.
# AGENTV_SYSTEMCTL and AGENTV_UFW are for the tests.
systemctl=${AGENTV_SYSTEMCTL:-systemctl}
ufw=${AGENTV_UFW:-ufw}

turn_off() {
  local unit

  for unit in "$@"; do
    # A unit that isn't on the box has nothing to turn off.
    [[ -n $("$systemctl" list-unit-files --no-legend "$unit" 2>/dev/null) ]] || continue
    if "$systemctl" disable --now "$unit" >/dev/null 2>&1; then
      echo "agentv: turned off $unit"
    else
      echo "agentv: couldn't turn off $unit" >&2
    fi
  done
}

# Docker: nothing of AgenTV's uses it, and the box's owner isn't in its
# group. Its socket would start the daemon, as root, for whoever asks.
# The socket goes first, so stopping the service can't start it again.
# To bring it back: sudo systemctl enable --now docker.socket
turn_off docker.socket docker.service

# Printing: a TV has nothing to print. CUPS and whatever looks for printers
# on the network go.
# To bring it back: sudo systemctl enable --now cups.service
turn_off cups-browsed.service cups.path cups.socket cups.service

# LocalSend: Omarchy opens its port, 53317, to every address, for sending
# files between desktops. The TV takes files from a paired phone instead.
# The rules go exactly as Omarchy's install/config/firewall.sh added them,
# for IPv4 and IPv6 alike. ufw says so and carries on when one is already
# gone. LocalSend itself stays installed.
# To bring it back: sudo ufw allow 53317/udp && sudo ufw allow 53317/tcp
if command -v "$ufw" >/dev/null 2>&1; then
  for proto in udp tcp; do
    "$ufw" --force delete allow "53317/$proto" >/dev/null 2>&1 ||
      echo "agentv: couldn't close LocalSend's port 53317/$proto" >&2
  done
  echo "agentv: LocalSend's port 53317 is closed"
fi
