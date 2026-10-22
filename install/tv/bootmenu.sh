# The box's own boot menu says AgenTV (ADR-027), the way the ISO's does. It
# shows for a few seconds at every power on: the header says AgenTV, and so
# does the entry, with its snapshots under it.
#
# Not before now: omarchy-iso's installer checks for an "Omarchy" entry while
# it installs. After that, Omarchy finds its entries by machine-id and hash,
# not by name. A drop-in names the OS for limine-entry-tool, sorting after
# Omarchy's own omarchy-defaults.conf, and limine-mkinitcpio, which Omarchy's
# own migrations use, writes the entries again with it.
install -d -m 755 /etc/limine-entry-tool.d
printf '%s\n' \
  '# AgenTV names the boot menu entry (ADR-027); after omarchy-defaults.conf.' \
  'TARGET_OS_NAME="AgenTV"' >/etc/limine-entry-tool.d/zz-agentv.conf

if [[ -x /usr/bin/limine-mkinitcpio ]]; then
  limine-mkinitcpio
fi

limine_conf=/boot/limine.conf
if [[ -f $limine_conf ]]; then
  sed -i 's/^interface_branding: .*/interface_branding: AgenTV/' "$limine_conf"
fi
