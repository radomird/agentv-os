# Straight to the TV at power on (ADR-007), in AgenTV's own TV session
# (ADR-031), and straight back after every log-out. Omarchy's installer only
# turns on autologin for an encrypted disk, where the disk password is the
# lock; a TV box installs without encryption, and the PIN (ADR-009) locks the
# TV. The owner's name comes from /etc/passwd, and it's written as a value,
# never run.
agentv-session-setup "$AGENTV_OWNER"
