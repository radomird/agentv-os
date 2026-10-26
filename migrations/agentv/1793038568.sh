# A theme changed on Omarchy's desktop, or picked on the TV, reaches the TV
# as soon as Omarchy has swapped it in (S5.2): boxes installed before get the
# owner's path unit started now, where there's a session to start it in.
# New boxes, and the next log-in here, get it from the package.
systemctl --user daemon-reload 2>/dev/null || true
systemctl --user start agentv-theme.path 2>/dev/null || true
