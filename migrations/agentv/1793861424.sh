# The TV lists the servers and shares on the home network: boxes installed
# before open the ports their answers come back to, 3006 to 3009, to the
# home network only. New boxes get this at first boot (install/tv/firewall.sh).
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
  sudo ufw allow proto udp from "$net" to any port 3006:3009 comment "agentv servers on your network" || true
done
