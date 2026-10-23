-- AgenTV on Omarchy's desktop (ADR-031): Super+Ctrl+Home goes back to the
-- TV. The agentv-plugin bar widget will offer the same, and this stays as
-- the keyboard's way. Omarchy's Hyprland loads it through the loader AgenTV
-- puts in Omarchy's toggles folder (bin/agentv-desktop-hook). In the TV
-- session, the same keys go to the desktop (session/hypr.lua).

hl.bind("SUPER + CTRL + Home", hl.dsp.exec_cmd("agentv tv"), { description = "Back to TV" })
