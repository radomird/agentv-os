# The box's own boot menu says AgenTV (ADR-027), the way the ISO's does. It
# shows for a few seconds at every power on: the header says AgenTV in
# AgenTV's blue, and so does the entry, with its snapshots under it.
#
# Not before now: omarchy-iso's installer checks for an "Omarchy" entry while
# it installs. limine-entry-tool finds the entry by its machine-id comment, not
# by its name, so renaming the entry it made is safe, and its own README says
# so. A drop-in, sorting after Omarchy's omarchy-defaults.conf, names any entry
# it makes from now on.
install -d -m 755 /etc/limine-entry-tool.d
printf '%s\n' \
  '# AgenTV names the boot menu entry (ADR-027); after omarchy-defaults.conf.' \
  'TARGET_OS_NAME="AgenTV"' >/etc/limine-entry-tool.d/zz-agentv.conf

limine_conf=/boot/limine.conf
if [[ -f $limine_conf ]]; then
  sed -i \
    -e 's/^interface_branding: .*/interface_branding: AgenTV/' \
    -e 's/^interface_branding_color: .*/interface_branding_color: 7aa2f7/' \
    -e 's|^/\(+\?\)Omarchy$|/\1AgenTV|' \
    -e 's/^comment: Omarchy$/comment: AgenTV/' \
    "$limine_conf"
fi
