# Builds aren't for every user on the box any more: a build can hold pages
# from a signed-in account. Boxes installed before close each build's folder
# to everyone but the builder and its group. The daemon and the builder's
# way out take that group when the update restarts AgenTV's services. New
# builds are made that way.
sudo systemd-sysusers agentv-builder.conf || true
sudo find /var/lib/agentv/build -mindepth 2 -maxdepth 2 -type d -exec chmod 0750 {} + || true
