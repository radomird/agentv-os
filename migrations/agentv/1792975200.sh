# The setup hotspot (stage 4): boxes installed before get its hand-over
# started now, so the home Wi-Fi a phone picks reaches root. New boxes get
# it from the package.
sudo systemctl start agentv-hotspot.path || true
