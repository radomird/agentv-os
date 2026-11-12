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
//
// And the listening bar (ADR-054), along the bottom over the app in front,
// while someone talks to the TV from their phone: listening, the words as
// the phone's dictation fills them in, thinking, then what came of it. It
// moves to say it's listening, calmly and with opacity only, and stands
// still with reduce motion. It never takes the keyboard or the mouse.
//   qs ipc -n -p /usr/share/agentv/session/toast call -- listen show <state> <words> <background> <foreground> <accent> <still>
//   qs ipc -n -p /usr/share/agentv/session/toast call -- listen hide
//
// And the typing bar (ADR-065), low over the app in front, while someone
// types on their phone: whose phone it is, and what's arriving, with a dot
// for each character of a password. The daemon sends the dots, never the
// password. It goes after a few seconds with no typing, and on Enter.
//   qs ipc -n -p /usr/share/agentv/session/toast call -- typing show <from> <text> <password> <background> <foreground> <accent>
//   qs ipc -n -p /usr/share/agentv/session/toast call -- typing hide

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
  property bool listenUp: false
  property string listenState: ""
  property string listenWords: ""
  property string listenBackground: "#1a1b26"
  property string listenForeground: "#a9b1d6"
  property string listenAccent: "#7aa2f7"
  property bool listenStill: false
  property bool typingUp: false
  property string typingFrom: ""
  property string typingText: ""
  property bool typingPassword: false
  property string typingBackground: "#1a1b26"
  property string typingForeground: "#c0caf5"
  property string typingAccent: "#7aa2f7"

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

  IpcHandler {
    target: "listen"

    function show(state: string, words: string, background: string, foreground: string, accent: string, still: string): string {
      root.listenState = state
      root.listenWords = words
      root.listenBackground = background
      root.listenForeground = foreground
      root.listenAccent = accent
      root.listenStill = still === "true"
      root.listenUp = true
      // What came of it stays a moment, then goes.
      if (state === "said")
        listenDone.restart()
      else
        listenDone.stop()
      return "ok"
    }

    // The bar fades as it is, and its words go once it's gone.
    function hide(): string {
      root.listenUp = false
      return "ok"
    }
  }

  IpcHandler {
    target: "typing"

    function show(from: string, text: string, password: string, background: string, foreground: string, accent: string): string {
      root.typingFrom = from
      root.typingText = text
      root.typingPassword = password === "true"
      root.typingBackground = background
      root.typingForeground = foreground
      root.typingAccent = accent
      root.typingUp = true
      typingDone.restart()
      return "ok"
    }

    function hide(): string {
      root.typingUp = false
      return "ok"
    }
  }

  // A few seconds with nothing new typed, and the bar goes.
  Timer {
    id: typingDone
    interval: 6000
    onTriggered: root.typingUp = false
  }

  Timer {
    id: listenDone
    interval: 6000
    onTriggered: root.listenUp = false
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
        text: "Home"
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

      Text {
        id: signInName
        anchors.left: parent.left
        anchors.leftMargin: 36
        anchors.verticalCenter: parent.verticalCenter
        text: root.signingIn
        color: "#c0caf5"
        font.family: "JetBrainsMono Nerd Font"
        font.pixelSize: 36
        font.bold: true
      }

      // Shown only while the hint still fits whole beside it, as on a 1080p
      // TV. The status line and the button say it too.
      Text {
        id: signInLabel
        anchors.left: signInName.right
        anchors.leftMargin: 24
        anchors.verticalCenter: parent.verticalCenter
        visible: signedInButton.x - (signInName.x + signInName.width + 24 + implicitWidth) >= signInHint.implicitWidth + 48
        text: "Sign in"
        color: "#a9b1d6"
        font.family: "JetBrainsMono Nerd Font"
        font.pixelSize: 26
      }

      // Centred in the room between the name and the button, so a long name
      // on a smaller screen never runs into it.
      Text {
        id: signInHint
        anchors.left: signInLabel.visible ? signInLabel.right : signInName.right
        anchors.right: signedInButton.left
        anchors.leftMargin: 24
        anchors.rightMargin: 24
        anchors.verticalCenter: parent.verticalCenter
        horizontalAlignment: Text.AlignHCenter
        elide: Text.ElideRight
        text: "Type on your phone or keyboard"
        color: "#a9b1d6"
        font.family: "JetBrainsMono Nerd Font"
        font.pixelSize: 26
      }

      // The app is asked again now; it's asked every 2 s anyway.
      Rectangle {
        id: signedInButton
        anchors.right: parent.right
        anchors.rightMargin: 36
        anchors.verticalCenter: parent.verticalCenter
        width: signedInLabel.implicitWidth + 64
        height: 72
        color: "#7aa2f7"

        Text {
          id: signedInLabel
          anchors.centerIn: parent
          text: "I'm signed in"
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
        text: "App setup · " + root.signingIn
        color: "#a9b1d6"
        font.family: "JetBrainsMono Nerd Font"
        font.pixelSize: 24
      }

      Text {
        anchors.right: parent.right
        anchors.rightMargin: 32
        anchors.verticalCenter: parent.verticalCenter
        text: "Home stops"
        color: "#a9b1d6"
        font.family: "JetBrainsMono Nerd Font"
        font.pixelSize: 24
      }
    }
  }
  PanelWindow {
    visible: root.listenUp || listenBar.opacity > 0
    anchors {
      left: true
      right: true
      bottom: true
    }
    // The TV's 5% safe area at the bottom.
    margins {
      left: 96
      right: 96
      bottom: 54
    }
    implicitHeight: 112
    color: "transparent"
    exclusionMode: ExclusionMode.Ignore
    WlrLayershell.namespace: "agentv-listening"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
    mask: Region {}

    // It fades in and out as home's does, at the base speed (ADR-024).
    Rectangle {
      id: listenBar
      anchors.fill: parent
      color: root.listenBackground
      border.color: root.listenAccent
      border.width: 2
      opacity: root.listenUp ? 1 : 0
      onOpacityChanged: if (opacity === 0) {
        root.listenState = ""
        root.listenWords = ""
      }

      Behavior on opacity {
        NumberAnimation { duration: 200; easing.type: Easing.BezierSpline; easing.bezierCurve: [0.2, 0.8, 0.2, 1, 1, 1] }
      }

      // Three squares that brighten in turn while it listens or thinks.
      Row {
        id: dots
        anchors.left: parent.left
        anchors.leftMargin: 36
        anchors.verticalCenter: parent.verticalCenter
        spacing: 12
        visible: root.listenState !== "said"

        Repeater {
          model: 3

          Rectangle {
            required property int index
            width: 16
            height: 16
            color: root.listenAccent
            opacity: root.listenStill ? 1 : 0.35

            SequentialAnimation on opacity {
              running: !root.listenStill && root.listenUp && root.listenState !== "said"
              loops: Animation.Infinite
              PauseAnimation { duration: index * 320 }
              NumberAnimation { to: 1; duration: 480; easing.type: Easing.InOutSine }
              NumberAnimation { to: 0.35; duration: 480; easing.type: Easing.InOutSine }
              PauseAnimation { duration: (2 - index) * 320 }
            }
          }
        }
      }

      Text {
        anchors.left: dots.visible ? dots.right : parent.left
        anchors.leftMargin: 36
        anchors.right: says.left
        anchors.rightMargin: 36
        anchors.verticalCenter: parent.verticalCenter
        elide: Text.ElideLeft
        text: root.listenWords !== "" ? root.listenWords : "Listening"
        color: root.listenForeground
        font.family: "JetBrainsMono Nerd Font"
        font.pixelSize: 36
      }

      // "thinking", once the sentence is sent.
      Text {
        id: says
        anchors.right: parent.right
        anchors.rightMargin: 36
        anchors.verticalCenter: parent.verticalCenter
        text: root.listenState === "thinking" ? "Thinking" : ""
        color: root.listenAccent
        font.family: "JetBrainsMono Nerd Font"
        font.pixelSize: 28
      }
    }
  }

  PanelWindow {
    visible: root.typingUp
    anchors {
      bottom: true
    }
    // In the TV's safe area, 60 px up, in the middle (D4).
    margins {
      bottom: 60
    }
    implicitWidth: 1100
    implicitHeight: 76
    color: "transparent"
    exclusionMode: ExclusionMode.Ignore
    WlrLayershell.namespace: "agentv-typing"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
    mask: Region {}

    Rectangle {
      anchors.fill: parent
      color: root.typingBackground
      border.color: root.typingAccent
      border.width: 3

      // Whose phone it is, on the accent.
      Rectangle {
        id: typingWho
        anchors.left: parent.left
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        width: whoText.implicitWidth + 48
        color: root.typingAccent

        Text {
          id: whoText
          anchors.centerIn: parent
          text: (root.typingPassword ? "\uf023  " : "") + root.typingFrom
          color: root.typingBackground
          font.family: "JetBrainsMono Nerd Font"
          font.pixelSize: 26
          font.weight: Font.ExtraBold
        }
      }

      // What's arriving, and a block for the caret.
      Row {
        anchors.left: typingWho.right
        anchors.leftMargin: 24
        anchors.right: parent.right
        anchors.rightMargin: 24
        anchors.verticalCenter: parent.verticalCenter
        spacing: 4
        clip: true

        Text {
          anchors.verticalCenter: parent.verticalCenter
          text: root.typingText
          color: root.typingForeground
          font.family: "JetBrainsMono Nerd Font"
          font.pixelSize: 36
          font.weight: Font.Bold
          font.letterSpacing: root.typingPassword ? 8 : 0
        }

        Rectangle {
          anchors.verticalCenter: parent.verticalCenter
          width: 20
          height: 40
          color: root.typingForeground
        }
      }
    }
  }
}
