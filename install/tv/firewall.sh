# The phone companion (stage 4): the daemon's port for phones, 3001, open to
# the home network and nowhere else. Omarchy's own firewall denies the rest.
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 fc00::/7 fe80::/10; do
  ufw allow from "$net" to any port 3001 proto tcp comment "agentv phone companion"
done

# Servers and shares on the home network: Jellyfin, Emby, Plex and Windows
# shares answer the box's questions on 3006 to 3009, from the home network
# only. Nothing listens there between looks.
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
  ufw allow proto udp from "$net" to any port 3006:3009 comment "agentv servers on your network"
done
