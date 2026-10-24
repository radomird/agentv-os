// AgenTV's toasts in the TV session (ADR-031): drawn the standard Wayland
// way, as a layer surface over the app in front, so a toast shows over a
// playing film too. It never takes the keyboard or the mouse.
//
// agentv-toast.service runs it with Quickshell, which comes with Omarchy.
// The screen daemon shows one with:
//   qs ipc -n -p /usr/share/agentv/session/toast call -- toast show "<text>"
// The real toasts, with What's new and the update notice, come with the
// home screen in stage 2.
//
// It also watches the seat for input: after 30 s with none, and when there's
// some again, it tells the screen daemon, which starts the ambient screen at
// the time Settings gives (ADR-031). Something playing in front holds it off.

import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland

ShellRoot {
  id: root

  property string message: ""
  property bool shown: false

  Timer {
    id: hideTimer
    interval: 5000
    onTriggered: root.shown = false
  }

  IdleMonitor {
    timeout: 30
    respectInhibitors: true
    onIsIdleChanged: {
      report.command = ["agentv", "screen", "idle", isIdle ? "yes" : "no"]
      report.running = true
    }
  }

  Process {
    id: report
  }

  IpcHandler {
    target: "toast"

    function show(text: string): string {
      root.message = text
      root.shown = true
      hideTimer.restart()
      return "ok"
    }
  }

  PanelWindow {
    visible: root.shown
    anchors {
      top: true
      right: true
    }
    // The TV's 5% safe area.
    margins {
      top: 54
      right: 96
    }
    implicitWidth: Math.min(label.implicitWidth + 64, 960)
    implicitHeight: label.implicitHeight + 40
    color: "transparent"
    exclusionMode: ExclusionMode.Ignore
    WlrLayershell.namespace: "agentv-toast"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
    mask: Region {}

    Rectangle {
      anchors.fill: parent
      color: "#1a1b26"
      border.color: "#7aa2f7"
      border.width: 2

      Text {
        id: label
        anchors.centerIn: parent
        width: Math.min(implicitWidth, 896)
        text: root.message
        color: "#c0caf5"
        font.family: "JetBrainsMono Nerd Font"
        font.pixelSize: 28
        wrapMode: Text.Wrap
      }
    }
  }
}
