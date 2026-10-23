# The daemon is daemon/server.ts now, in place of the stage 0 placeholder. Its
# unit changed with the package, so restart it rather than wait for the next
# start. The TV keeps the page it shows; the next one comes from the new daemon.
sudo systemctl try-restart agentv-daemon.service
