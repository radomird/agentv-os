// AgenTV's toasts in the TV session (ADR-031): drawn the standard Wayland
// way, as a layer surface over the app in front, so a toast shows over a
// playing film too. A toast never takes the keyboard or the mouse.
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
//
// And it has the mouse's Home (ADR-031). While an app is in front, the
// pointer pushed into the top left corner shows a Home button there, and a
// click goes home, as the Home key does. The screen daemon says when an app
// is in front:
//   qs ipc -n -p /usr/share/agentv/session/toast call -- corner front true
//
// And AgenTV's sign-in screen (ADR-032, board 15): a bar along the bottom
// with the app's name, where to type, and "i'm signed in", under the
// service's own sign-in page. It keeps the bottom of the screen for itself,
// so the page, maximized above it, isn't covered, and it never takes the
// keyboard, so typing goes to the page. The screen daemon shows and hides it:
//   qs ipc -n -p /usr/share/agentv/session/toast call -- signin show "Jellyfin"
//   qs ipc -n -p /usr/share/agentv/session/toast call -- signin hide

import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland

ShellRoot {
  id: root

  property string message: ""
  property bool shown: false
  property bool appInFront: false
  property bool cornerOpen: false
  property string signingIn: ""

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

  IpcHandler {
    target: "corner"

    function front(on: bool): string {
      root.appInFront = on
      if (!on)
        root.cornerOpen = false
      return "ok"
    }
  }

  IpcHandler {
    target: "signin"

    function show(name: string): string {
      root.signingIn = name
      return "ok"
    }

    function hide(): string {
      root.signingIn = ""
      return "ok"
    }
  }

  Process {
    id: signedIn
    command: ["agentv", "screen", "signed-in"]
  }

  // After the overlay starts again, what's in front now.
  Process {
    running: true
    command: ["agentv", "screen", "status"]
    stdout: StdioCollector {
      id: frontNow
      waitForEnd: true
    }
    onExited: {
      try {
        const front = JSON.parse(frontNow.text).front
        root.appInFront = Boolean(front && front.role && front.role !== "home")
      } catch (e) {
      }
    }
  }

  Process {
    id: goHome
    command: ["agentv", "screen", "home"]
  }

  // It goes away a moment after the pointer leaves it, or after a while
  // when the pointer was only passing.
  Timer {
    id: cornerClose
    interval: 1500
    onTriggered: {
      if (!buttonArea.containsMouse)
        root.cornerOpen = false
    }
  }

  PanelWindow {
    visible: root.appInFront
    anchors {
      top: true
      left: true
    }
    implicitWidth: cornerButton.width
    implicitHeight: cornerButton.height
    color: "transparent"
    exclusionMode: ExclusionMode.Ignore
    WlrLayershell.namespace: "agentv-corner"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
    // Until it opens, it takes the pointer only in the corner itself, so
    // the app gets every other click.
    mask: Region {
      item: root.cornerOpen ? cornerButton : hotCorner
    }

    MouseArea {
      id: hotCorner
      width: 4
      height: 4
      hoverEnabled: true
      onEntered: {
        root.cornerOpen = true
        cornerClose.restart()
      }
    }

    Rectangle {
      id: cornerButton
      width: 240
      height: 104
      visible: root.cornerOpen
      color: "#7aa2f7"

      Text {
        anchors.centerIn: parent
        text: "home"
        color: "#1a1b26"
        font.family: "JetBrainsMono Nerd Font"
        font.pixelSize: 32
        font.bold: true
      }

      MouseArea {
        id: buttonArea
        anchors.fill: parent
        hoverEnabled: true
        enabled: root.cornerOpen
        onExited: cornerClose.restart()
        onClicked: {
          root.cornerOpen = false
          goHome.running = true
        }
      }
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

  PanelWindow {
    visible: root.signingIn !== ""
    anchors {
      left: true
      right: true
      bottom: true
    }
    implicitHeight: 220
    color: "#101014"
    exclusionMode: ExclusionMode.Auto
    WlrLayershell.namespace: "agentv-signin"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.None

    Rectangle {
      anchors {
        left: parent.left
        right: parent.right
        bottom: parent.bottom
        leftMargin: 32
        rightMargin: 32
        bottomMargin: 84
      }
      height: 112
      color: "#1a1b26"
      border.color: "#292e42"
      border.width: 2

      Row {
        anchors.left: parent.left
        anchors.leftMargin: 36
        anchors.verticalCenter: parent.verticalCenter
        spacing: 24

        Text {
          anchors.verticalCenter: parent.verticalCenter
          text: root.signingIn.toLowerCase()
          color: "#c0caf5"
          font.family: "JetBrainsMono Nerd Font"
          font.pixelSize: 36
          font.bold: true
        }

        Text {
          anchors.verticalCenter: parent.verticalCenter
          text: "sign in"
          color: "#a9b1d6"
          font.family: "JetBrainsMono Nerd Font"
          font.pixelSize: 26
        }
      }

      Text {
        anchors.centerIn: parent
        text: "type on your phone or keyboard"
        color: "#a9b1d6"
        font.family: "JetBrainsMono Nerd Font"
        font.pixelSize: 26
      }

      // The app is asked again now; it's asked every 2 s anyway.
      Rectangle {
        anchors.right: parent.right
        anchors.rightMargin: 36
        anchors.verticalCenter: parent.verticalCenter
        width: signedInLabel.implicitWidth + 64
        height: 72
        color: "#7aa2f7"

        Text {
          id: signedInLabel
          anchors.centerIn: parent
          text: "i'm signed in"
          color: "#1a1b26"
          font.family: "JetBrainsMono Nerd Font"
          font.pixelSize: 28
          font.bold: true
        }

        MouseArea {
          anchors.fill: parent
          onClicked: signedIn.running = true
        }
      }
    }

    Rectangle {
      anchors {
        left: parent.left
        right: parent.right
        bottom: parent.bottom
      }
      height: 60
      color: "#16161e"

      Text {
        anchors.left: parent.left
        anchors.leftMargin: 32
        anchors.verticalCenter: parent.verticalCenter
        text: "app setup · " + root.signingIn.toLowerCase()
        color: "#a9b1d6"
        font.family: "JetBrainsMono Nerd Font"
        font.pixelSize: 24
      }

      Text {
        anchors.right: parent.right
        anchors.rightMargin: 32
        anchors.verticalCenter: parent.verticalCenter
        text: "home stops"
        color: "#a9b1d6"
        font.family: "JetBrainsMono Nerd Font"
        font.pixelSize: 24
      }
    }
  }
}
