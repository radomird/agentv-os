# Phones pair with the box on the home network now (stage 4): boxes installed
# before open the daemon's port for phones, 3001, to the home network only.
# New boxes get this at first boot (install/tv/firewall.sh).
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 fc00::/7 fe80::/10; do
  sudo ufw allow from "$net" to any port 3001 proto tcp comment "agentv phone companion" || true
done
