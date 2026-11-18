# The TV can say it's there on the home network, so a paired phone finds it
# again at a new address. Boxes installed before get the firewall's line
# for it, and the hand-over that writes what Avahi announces, started now.
# New boxes get the line at first boot (install/tv/firewall.sh) and the
# hand-over from the package. Nothing is announced until the announce switch
# is on.
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
  sudo ufw allow proto udp from "$net" to any port 5353 comment "origaitv found on your network" || true
done
sudo systemctl start origaitv-announce.path || true
