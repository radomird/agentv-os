# Less of Omarchy's desktop switched on: boxes installed before get what
# first boot now does (install/tv/services.sh). Docker's socket and printing
# are turned off, and LocalSend's port is closed. Each comes back with a
# plain systemctl enable --now, or ufw allow.
sudo bash "$AGENTV_PATH/install/tv/services.sh"
