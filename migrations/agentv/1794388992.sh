# A TV that loses its network opens its hotspot again by itself: TVs
# installed before get the watch that does it started now, without waiting
# for a restart. New TVs get it from the package.
sudo systemctl start agentv-hotspot-watch.service || true
