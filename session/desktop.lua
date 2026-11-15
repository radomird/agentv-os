-- origaiTV on Omarchy's desktop (ADR-031): Super+Ctrl+Home goes back to the
-- TV. The origaitv-plugin bar widget will offer the same, and this stays as
-- the keyboard's way. Omarchy's Hyprland loads it through the loader origaiTV
-- puts in Omarchy's toggles folder (bin/origaitv-desktop-hook). In the TV
-- session, the same keys go to the desktop (session/hypr.lua).

hl.bind("SUPER + CTRL + Home", hl.dsp.exec_cmd("origaitv tv"), { description = "Back to TV" })
