# A NAS share's password stays on the box, root's alone, and the share mounts
# again after a restart (ADR-038): boxes installed before get the drop folder
# and the hand-over started now. New boxes get them from the package. A share
# added with a password before this needs it once more, in Music → sources.
sudo systemd-tmpfiles --create agentv-shares.conf || true
sudo systemctl start agentv-share.path || true
