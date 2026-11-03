# The box's country moves its time zone (ADR-055): boxes installed before
# get the hand-over from the daemon started now. New boxes get it from the
# package.
sudo systemctl start agentv-zone.path || true
