# Straight to the TV at power on (ADR-007). Omarchy's installer only turns on
# autologin for an encrypted disk, where the disk password is the lock; a TV
# box installs without encryption, and the PIN (ADR-009) locks the TV. The
# owner's name comes from /etc/passwd, and it's written as a value, never run.
install -d -m 755 /etc/sddm.conf.d
printf '[Autologin]\nUser=%s\nSession=omarchy.desktop\n' "$AGENTV_OWNER" >/etc/sddm.conf.d/agentv-autologin.conf
