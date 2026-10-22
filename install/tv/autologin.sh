# Straight to the TV at power on (ADR-007). Omarchy's installer only turns on
# autologin for an encrypted disk, where the disk password is the lock; a TV
# box installs without encryption, and the PIN (ADR-009) locks the TV.
install -d -m 755 /etc/sddm.conf.d
cat >/etc/sddm.conf.d/agentv-autologin.conf <<CONF
[Autologin]
User=$AGENTV_OWNER
Session=omarchy.desktop
CONF
