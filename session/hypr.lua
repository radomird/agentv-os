-- AgenTV's TV session (ADR-031): Hyprland with AgenTV's setup and nothing of
-- Omarchy's desktop. No bar, notices, screensaver, idle lock or desktop
-- keybindings. bin/agentv-session starts Hyprland with this file, and
-- AgenTV's screen daemon (daemon/screen.ts) decides over Hyprland's IPC which
-- window is in front.
--
-- Every window opens out of sight, on a special workspace that's never shown,
-- and without focus. The daemon brings the one it wants to workspace 1 and
-- makes it full screen. So nothing takes the screen on its own, even before
-- the daemon has seen it.

local agentv_path = os.getenv("AGENTV_PATH") or "/usr/share/agentv"

-- What programs started from here see. The screen daemon and the virtual
-- input device get the same through systemd at start, below.
hl.env("AGENTV_SESSION", "tv")
hl.env("AGENTV_PATH", agentv_path)
hl.env("XDG_SESSION_TYPE", "wayland")
hl.env("GDK_BACKEND", "wayland,x11,*")
hl.env("QT_QPA_PLATFORM", "wayland;xcb")
hl.env("OZONE_PLATFORM", "wayland")
hl.env("ELECTRON_OZONE_PLATFORM_HINT", "wayland")
hl.env("XCURSOR_SIZE", "24")
hl.env("HYPRCURSOR_SIZE", "24")

-- The TV's preferred mode. Auto scale keeps the UI the same size on a 4K TV.
hl.monitor({ output = "", mode = "preferred", position = "auto", scale = "auto" })

-- The keyboard layout the installer set, the way Omarchy's desktop reads it.
local function vconsole()
  local values = {}
  local file = io.open("/etc/vconsole.conf", "r")
  if not file then
    return values
  end
  for line in file:lines() do
    local key, value = line:match("^%s*([%w_]+)%s*=%s*(.-)%s*$")
    if key and value then
      values[key] = value:gsub("%s+#.*$", ""):gsub('^"(.*)"$', "%1"):gsub("^'(.*)'$", "%1")
    end
  end
  file:close()
  return values
end
local keyboard = vconsole()

-- The splash's background, for the TV session's first frame, while
-- AgenTV's splash is kept from the boot to home (ADR-060,
-- bin/agentv-boot-splash leaves the note). It's the colour Plymouth drew,
-- from its theme's script, so the hand-over shows no other colour.
local function splash_background()
  local note = io.open("/run/agentv-boot-splash", "r")
  if not note then
    return nil
  end
  note:close()
  local file = io.open("/usr/share/plymouth/themes/omarchy/omarchy.script", "r")
  if not file then
    return nil
  end
  local colour = nil
  for line in file:lines() do
    local r, g, b = line:match("^Window%.SetBackgroundTopColor%(%s*([%d.]+)%s*,%s*([%d.]+)%s*,%s*([%d.]+)%s*%)")
    if r then
      local function byte(value)
        return math.max(0, math.min(255, math.floor(tonumber(value) * 255 + 0.5)))
      end
      colour = string.format("rgb(%02x%02x%02x)", byte(r), byte(g), byte(b))
      break
    end
  end
  file:close()
  return colour
end

hl.config({
  input = {
    kb_layout = keyboard.XKBLAYOUT or "us",
    kb_variant = keyboard.XKBVARIANT or "",
    repeat_rate = 40,
    repeat_delay = 250,
    numlock_by_default = true,
  },

  -- One window fills the screen at a time, edge to edge.
  general = {
    gaps_in = 0,
    gaps_out = 0,
    border_size = 0,
    allow_tearing = false,
    layout = "dwindle",
  },

  decoration = {
    rounding = 0,
    shadow = { enabled = false },
    blur = { enabled = false },
  },

  -- The home screen draws its own motion (ADR-024).
  animations = { enabled = false },

  misc = {
    disable_hyprland_logo = true,
    disable_splash_rendering = true,
    disable_scale_notification = true,
    disable_hyprland_guiutils_check = true,
    disable_watchdog_warning = true,
    -- The TV session sets its own XDG_CURRENT_DESKTOP (AgenTV:Hyprland), and
    -- Hyprland would say so in a notice over the TV.
    disable_xdg_env_checks = true,
    force_default_wallpaper = 0,
    -- The splash's background while AgenTV's splash is kept from the boot
    -- (above), and Tokyo Night's otherwise, for the moment before the home
    -- screen draws.
    background_color = splash_background() or "rgb(1a1b26)",
    -- Nothing comes to the front by asking for it.
    focus_on_activate = false,
    on_focus_under_fullscreen = 0,
    exit_window_retains_fullscreen = 0,
    initial_workspace_tracking = 0,
    -- No "not responding" dialog over the TV: the daemon restarts the home
    -- screen itself.
    enable_anr_dialog = false,
    middle_click_paste = false,
    key_press_enables_dpms = true,
    mouse_move_enables_dpms = true,
    -- An update rewrites this file while the session runs. The new one
    -- takes over at the next start, not halfway through.
    disable_autoreload = true,
  },

  cursor = {
    hide_on_key_press = true,
    inactive_timeout = 3,
  },

  ecosystem = {
    no_update_news = true,
    no_donation_nag = true,
  },
})

-- Out of sight until the daemon says otherwise.
hl.window_rule({
  name = "agentv-held",
  match = { class = ".*" },
  workspace = "special:agentv-held silent",
  no_initial_focus = true,
  suppress_event = "fullscreen maximize activate activatefocus fullscreenoutput",
})

-- Omarchy's desktop, for maintenance, until Settings has its entry (stage
-- 2). agentv desktop asks for the PIN first, once there is one (stage 4).
hl.bind("SUPER + CTRL + Home", hl.dsp.exec_cmd("agentv desktop"), { description = "Omarchy's desktop" })

-- Home from every input (ADR-031): a keyboard's Home key and a remote's Home
-- button, which the phone sends through the virtual input device too. The
-- gamepad's guide button reaches the daemon from input.py.
hl.bind("Home", hl.dsp.exec_cmd("agentv screen home"), { description = "Home" })
hl.bind("XF86HomePage", hl.dsp.exec_cmd("agentv screen home"), { description = "Home" })

-- Back stays the app's, and holding it for a second goes home. Each press and
-- release says when it happened, since the two commands can arrive out of
-- order.
for _, key in ipairs({ "Escape", "XF86Back" }) do
  hl.bind(key, hl.dsp.exec_cmd("agentv screen back down $(date +%s%3N)"), { non_consuming = true })
  hl.bind(key, hl.dsp.exec_cmd("agentv screen back up $(date +%s%3N)"), { non_consuming = true, release = true })
end

hl.on("hyprland.start", function()
  -- AgenTV's splash first, before anything else starts, so it's up as soon
  -- as it can be (ADR-060). It draws only when the boot kept the splash.
  -- Plymouth, which let go of the screen and kept its last frame up, quits
  -- once home has drawn (agentv-boot-splash done): this session's first
  -- frame can come a second or more after it starts.
  hl.exec_cmd("agentv-boot-splash tv")
  -- The screen daemon, the virtual input device and the toast overlay run
  -- as user units under agentv-tv.target, and need this session's display.
  hl.exec_cmd(
    "systemctl --user import-environment WAYLAND_DISPLAY HYPRLAND_INSTANCE_SIGNATURE XDG_CURRENT_DESKTOP XDG_SESSION_TYPE"
      .. " && dbus-update-activation-environment --systemd WAYLAND_DISPLAY HYPRLAND_INSTANCE_SIGNATURE XDG_CURRENT_DESKTOP XDG_SESSION_TYPE"
      .. " ; systemctl --user start agentv-tv.target"
  )
end)
