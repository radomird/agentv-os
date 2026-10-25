# The phone companion (stage 4): the daemon's port for phones, 3001, open to
# the home network and nowhere else. Omarchy's own firewall denies the rest.
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 fc00::/7 fe80::/10; do
  ufw allow from "$net" to any port 3001 proto tcp comment "agentv phone companion"
done
