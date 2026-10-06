import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "monke.t3-board"

  property var record: ({})
  property bool online: false
  readonly property string home: Quickshell.env("HOME")
  readonly property string lightingStatus: !online ? "Service unavailable"
    : !record.lightingEnabled ? "Lighting paused"
    : record.streaming ? "Lighting running"
    : "Waiting to reconnect"
  readonly property string details: "T3 Board\n" + lightingStatus
    + (online ? "\n" + record.working + " working · " + record.finished + " finished · " + record.errors + " errors"
      + "\n" + record.assigned + "/14 keys assigned" + (record.overflow ? " · " + record.overflow + " waiting for a key" : "") : "")
    + (record.error ? "\n" + record.error : "")
    + "\nLeft-click: open controls\nRight-click: pause / resume lighting"

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  function refresh() {
    if (!statusProcess.running) statusProcess.running = true
  }

  function openControls() {
    if (!launchProcess.running) launchProcess.running = true
  }

  function toggleLighting() {
    if (!toggleProcess.running) toggleProcess.running = true
  }

  function applyRecord(text) {
    try { record = JSON.parse(text); online = true }
    catch (_) { online = false }
  }

  Timer {
    interval: 2000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Process {
    id: statusProcess
    command: ["curl", "-fsS", "--max-time", "1", "http://127.0.0.1:47831/api/summary"]
    stdout: StdioCollector { onStreamFinished: root.applyRecord(text) }
    onExited: function(code) { if (code !== 0) root.online = false }
  }

  Process {
    id: launchProcess
    command: [root.home + "/.local/bin/t3-board"]
  }

  Process {
    id: toggleProcess
    command: [root.home + "/.local/bin/t3-boardctl", "toggle"]
    stdout: StdioCollector { onStreamFinished: root.applyRecord(text) }
    onExited: root.refresh()
  }

  IpcHandler {
    target: "monke.t3-board"
    function refresh(): void { root.broadcast("refresh") }
    function toggleLighting(): void { root.toggleLighting() }
    function status(): string { return JSON.stringify({ online: root.online, record: root.record, tooltip: root.details }) }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰌌" + (root.vertical ? "" : " " + (root.online ? root.record.working : "–"))
    tooltipText: root.details
    foreground: root.online && (root.record.error || root.record.errors) ? Color.urgent
      : root.online && root.record.streaming ? (root.bar ? root.bar.barForeground : Color.foreground) : Color.muted
    onPressed: function(b) {
      if (b === Qt.RightButton) root.toggleLighting()
      else root.openControls()
    }
  }
}
