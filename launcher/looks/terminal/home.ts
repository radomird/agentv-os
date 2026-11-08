// Terminal's home (ADR-014, ADR-015, D1): the profile's tiles in their
// places on the grid, like Hyprland's windows, with the bar along the bottom.
// It's phase 1's home, with no all apps tile and Clock no longer pinned, and
// the grid inside the safe area.

import type { Ctx, View } from "../../main.ts";
import { home as grid } from "../../pages/home.ts";

export function home(ctx: Ctx): View {
  return grid(ctx);
}
