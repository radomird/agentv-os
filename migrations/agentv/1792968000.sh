# The provider key goes where only root can read it (S4.6): boxes installed
# before get the hand-over from the daemon started now. New boxes get it from
# the package.
sudo systemctl start agentv-key.path || true
