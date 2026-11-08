# Straight to the TV (ADR-060): boxes installed before get the boot menu's
# drop-in again, now with the kernel option that keeps the boot splash up on
# a box with a serial console, and the boot image is rebuilt to carry it.
sudo bash "$AGENTV_PATH/install/tv/bootmenu.sh"
if omarchy-cmd-present limine-mkinitcpio; then
  sudo limine-mkinitcpio
fi
