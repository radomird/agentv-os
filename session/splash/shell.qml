// AgenTV's splash in the TV session (ADR-060): the boot splash's logo on its
// background, drawn over everything from the moment the TV session starts
// until the screen daemon says home's page has drawn under it. Plymouth left
// the same picture on the screen as it quit, so the boot runs from the
// firmware's logo to home with only AgenTV's splash between them.
//
// bin/agentv-boot-splash tv starts it with the splash's background and logo
// in AGENTV_SPLASH_BACKGROUND and AGENTV_SPLASH_LOGO, and
// bin/agentv-boot-splash done ends it:
//   qs ipc -n -p /usr/share/agentv/session/splash call splash done
// It never takes the keyboard or the mouse, and ends by itself after 90 s,
// so a home screen that never comes can't leave it up.

import QtQuick
import QtQuick.Window
import Quickshell
import Quickshell.Io
import Quickshell.Wayland

ShellRoot {
  id: root

  readonly property string background: Quickshell.env("AGENTV_SPLASH_BACKGROUND") || "#1a1b26"
  readonly property string logo: Quickshell.env("AGENTV_SPLASH_LOGO") || "/usr/share/plymouth/themes/omarchy/logo.png"

  PanelWindow {
    anchors {
      top: true
      bottom: true
      left: true
      right: true
    }
    color: root.background
    exclusionMode: ExclusionMode.Ignore
    WlrLayershell.namespace: "agentv-splash"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
    mask: Region {}

    // Centred at the size Plymouth drew it, in the screen's own pixels, the
    // way its theme script places it.
    Image {
      anchors.centerIn: parent
      source: "file://" + root.logo
      width: sourceSize.width / Screen.devicePixelRatio
      height: sourceSize.height / Screen.devicePixelRatio
      fillMode: Image.PreserveAspectFit
      smooth: false
    }
  }

  Timer {
    interval: 90000
    running: true
    onTriggered: Qt.quit()
  }

  IpcHandler {
    target: "splash"

    function done(): string {
      Qt.quit()
      return "ok"
    }
  }
}
