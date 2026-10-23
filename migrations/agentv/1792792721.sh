# The box looks for updates once a day now, for Settings → Updates (ADR-025).
# The package enables the timer; a box installed before starts it here
# instead of at the next restart.
sudo systemctl start agentv-update-check.timer || true
