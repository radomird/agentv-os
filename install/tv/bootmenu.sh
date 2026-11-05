# The box's own boot menu says AgenTV (ADR-027), the way the ISO's does: the
# header says AgenTV in AgenTV's blue, and so does the entry, with its
# snapshots under it.
#
# It stays hidden at power on (ADR-060). Omarchy 4.5's Limine waits one
# quiet second, with nothing on the screen, and a key in that second shows
# the menu. AgenTV keeps Omarchy's timeout and writes none of its own, and
# Settings → Power can restart the box to the menu, which then waits.
#
# Not before now: omarchy-iso's installer checks for an "Omarchy" entry while
# it installs. limine-entry-tool finds the entry by its machine-id comment, not
# by its name, so renaming the entry it made is safe, and its own README says
# so. A drop-in, sorting after Omarchy's omarchy-defaults.conf, names any entry
# it makes from now on.
#
# The same drop-in keeps the boot splash up on a box whose firmware names a
# serial console, as some PCs and every VM do: Plymouth would otherwise print
# the boot's log on the TV instead of drawing the splash (ADR-060). The boot
# image carries the kernel's command line, so it takes effect once that's
# rebuilt, which first boot's branding does next.
install -d -m 755 /etc/limine-entry-tool.d
printf '%s\n' \
  '# AgenTV names the boot menu entry (ADR-027); after omarchy-defaults.conf.' \
  'TARGET_OS_NAME="AgenTV"' \
  '# The splash, never the boot log, with a serial console too (ADR-060).' \
  'KERNEL_CMDLINE[default]+=" plymouth.ignore-serial-consoles"' >/etc/limine-entry-tool.d/zz-agentv.conf

limine_conf=/boot/limine.conf
if [[ -f $limine_conf ]]; then
  sed -i \
    -e 's/^interface_branding: .*/interface_branding: AgenTV/' \
    -e 's/^interface_branding_color: .*/interface_branding_color: 7aa2f7/' \
    -e 's|^/\(+\?\)Omarchy$|/\1AgenTV|' \
    -e 's/^comment: Omarchy$/comment: AgenTV/' \
    "$limine_conf"
fi
