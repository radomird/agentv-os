# The desktop's password from Settings: boxes installed before get its
# hand-over to root started now, and the daemon again with the group that
# reaches it. New boxes get both from the package.
sudo systemctl start agentv-password.socket || true
sudo systemctl try-restart agentv-daemon.service || true
