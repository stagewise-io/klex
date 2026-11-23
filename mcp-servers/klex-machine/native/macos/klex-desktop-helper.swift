// Input, window and launch helper for klex-machine's macOS desktop provider
// (src/desktop/platform/macos.ts). Coordinates are global display points.
// Queries print one JSON value on stdout; failures exit nonzero with a message
// on stderr (2 for bad arguments, 3 for missing Accessibility permission).

import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation

let helperVersion = "1"

func fail(_ message: String, code: Int32 = 1) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(code)
}

func emit(_ value: Any) {
  guard JSONSerialization.isValidJSONObject(value),
    let data = try? JSONSerialization.data(withJSONObject: value)
  else { fail("Could not encode the result") }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

func number(_ text: String) -> Double {
  guard let value = Double(text), value.isFinite else {
    fail("Invalid number: \(text)", code: 2)
  }
  return value
}

func positiveCount(_ text: String) -> Int {
  guard let value = Int(text), value >= 1, value <= 100 else {
    fail("Invalid count: \(text)", code: 2)
  }
  return value
}

func pause(_ milliseconds: UInt32) {
  usleep(milliseconds * 1_000)
}

// MARK: Display

func displayInfo() -> [String: Any] {
  let id = CGMainDisplayID()
  let bounds = CGDisplayBounds(id)
  var pixelWidth = Int(bounds.width)
  var pixelHeight = Int(bounds.height)
  if let mode = CGDisplayCopyDisplayMode(id) {
    pixelWidth = mode.pixelWidth
    pixelHeight = mode.pixelHeight
    // Modes are unrotated; bounds follow the rotation.
    let rotation = Int(CGDisplayRotation(id)) % 180
    if rotation == 90 { swap(&pixelWidth, &pixelHeight) }
  }
  return [
    "width": Double(bounds.width),
    "height": Double(bounds.height),
    "pixelWidth": pixelWidth,
    "pixelHeight": pixelHeight,
  ]
}

func requireAccessibility() {
  if !AXIsProcessTrusted() {
    fail("Accessibility permission is missing; input events would be dropped", code: 3)
  }
}

// MARK: Mouse

let eventSource = CGEventSource(stateID: .hidSystemState)

struct MouseButton {
  let down: CGEventType
  let up: CGEventType
  let dragged: CGEventType
  let button: CGMouseButton
}

func mouseButton(_ name: String) -> MouseButton {
  switch name {
  case "left":
    return MouseButton(down: .leftMouseDown, up: .leftMouseUp, dragged: .leftMouseDragged, button: .left)
  case "right":
    return MouseButton(down: .rightMouseDown, up: .rightMouseUp, dragged: .rightMouseDragged, button: .right)
  case "middle":
    return MouseButton(down: .otherMouseDown, up: .otherMouseUp, dragged: .otherMouseDragged, button: .center)
  default:
    fail("Unknown mouse button: \(name)", code: 2)
  }
}

// A nil event is skipped rather than fatal so held modifiers are still released.
func post(_ event: CGEvent?) {
  event?.post(tap: .cghidEventTap)
}

func mouseEvent(
  _ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton, flags: CGEventFlags = []
) -> CGEvent? {
  let event = CGEvent(
    mouseEventSource: eventSource, mouseType: type, mouseCursorPosition: point, mouseButton: button)
  event?.flags = flags
  return event
}

func moveMouse(_ point: CGPoint) {
  post(mouseEvent(.mouseMoved, point, .left))
}

func click(_ point: CGPoint, _ button: MouseButton, clicks: Int, modifiers: [String]) {
  moveMouse(point)
  pause(30)
  withModifiers(modifiers) { flags in
    for index in 1...clicks {
      for type in [button.down, button.up] {
        let event = mouseEvent(type, point, button.button, flags: flags)
        event?.setIntegerValueField(.mouseEventClickState, value: Int64(index))
        post(event)
      }
      if index < clicks { pause(60) }
    }
  }
}

func drag(from: CGPoint, to: CGPoint, _ button: MouseButton) {
  moveMouse(from)
  pause(50)
  post(mouseEvent(button.down, from, button.button))
  pause(80)
  let steps = 12
  for step in 1...steps {
    let progress = CGFloat(step) / CGFloat(steps)
    let point = CGPoint(
      x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress)
    post(mouseEvent(button.dragged, point, button.button))
    pause(15)
  }
  pause(50)
  post(mouseEvent(button.up, to, button.button))
}

// One step is three lines, roughly one wheel notch on Linux.
func scroll(_ point: CGPoint, direction: String, steps: Int) {
  let delta: (vertical: Int32, horizontal: Int32)
  switch direction {
  case "up": delta = (3, 0)
  case "down": delta = (-3, 0)
  case "left": delta = (0, 3)
  case "right": delta = (0, -3)
  default: fail("Unknown scroll direction: \(direction)", code: 2)
  }
  moveMouse(point)
  pause(30)
  for _ in 0..<steps {
    post(
      CGEvent(
        scrollWheelEvent2Source: eventSource, units: .line, wheelCount: 2,
        wheel1: delta.vertical, wheel2: delta.horizontal, wheel3: 0))
    pause(20)
  }
}

// MARK: Keyboard

let modifierKeys: [String: (code: CGKeyCode, flag: CGEventFlags)] = [
  "cmd": (55, .maskCommand),
  "shift": (56, .maskShift),
  "alt": (58, .maskAlternate),
  "ctrl": (59, .maskControl),
  "fn": (63, .maskSecondaryFn),
]

func modifierList(_ text: String) -> [String] {
  return text.split(separator: ",").map { part in
    let name = String(part)
    if modifierKeys[name] == nil { fail("Unknown modifier: \(name)", code: 2) }
    return name
  }
}

func keyEvent(_ code: CGKeyCode, down: Bool, flags: CGEventFlags) -> CGEvent? {
  let event = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: down)
  event?.flags = flags
  return event
}

func withModifiers(_ names: [String], _ body: (CGEventFlags) -> Void) {
  var held = CGEventFlags()
  for name in names {
    guard let key = modifierKeys[name] else { continue }
    held.insert(key.flag)
    post(keyEvent(key.code, down: true, flags: held))
    pause(10)
  }
  body(held)
  for name in names.reversed() {
    guard let key = modifierKeys[name] else { continue }
    held.remove(key.flag)
    post(keyEvent(key.code, down: false, flags: held))
    pause(10)
  }
}

func tapKey(_ code: CGKeyCode, flags: CGEventFlags = []) {
  post(keyEvent(code, down: true, flags: flags))
  pause(10)
  post(keyEvent(code, down: false, flags: flags))
}

struct KeyStroke {
  let code: CGKeyCode
  /** Modifiers the layout needs to produce the character, such as shift for `+` on US. */
  let modifiers: [String]
}

// US ANSI positions, used when the current layout cannot be read.
let ansiKeys: [String: KeyStroke] = {
  var keys: [String: KeyStroke] = [:]
  let unshifted: [(String, CGKeyCode)] = [
    ("a", 0), ("s", 1), ("d", 2), ("f", 3), ("h", 4), ("g", 5), ("z", 6), ("x", 7), ("c", 8),
    ("v", 9), ("b", 11), ("q", 12), ("w", 13), ("e", 14), ("r", 15), ("y", 16), ("t", 17),
    ("1", 18), ("2", 19), ("3", 20), ("4", 21), ("6", 22), ("5", 23), ("=", 24), ("9", 25),
    ("7", 26), ("-", 27), ("8", 28), ("0", 29), ("]", 30), ("o", 31), ("u", 32), ("[", 33),
    ("i", 34), ("p", 35), ("l", 37), ("j", 38), ("'", 39), ("k", 40), (";", 41), ("\\", 42),
    (",", 43), ("/", 44), ("n", 45), ("m", 46), (".", 47), ("`", 50),
  ]
  for (character, code) in unshifted { keys[character] = KeyStroke(code: code, modifiers: []) }
  let shifted: [(String, CGKeyCode)] = [
    ("!", 18), ("@", 19), ("#", 20), ("$", 21), ("^", 22), ("%", 23), ("+", 24), ("(", 25),
    ("&", 26), ("_", 27), ("*", 28), (")", 29), ("}", 30), ("{", 33), ("\"", 39), (":", 41),
    ("|", 42), ("<", 43), ("?", 44), (">", 47), ("~", 50),
  ]
  for (character, code) in shifted {
    keys[character] = KeyStroke(code: code, modifiers: ["shift"])
  }
  return keys
}()

// Characters to key codes for the current layout, so shortcuts such as cmd+z
// hit the key labelled Z on non-US layouts too. Plain keys win over Shift,
// Shift over Option (AltGr), so `@` on a German layout is Option+L.
func layoutKeys() -> [String: KeyStroke] {
  var keys: [String: KeyStroke] = [:]
  guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
    let property = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
  else { return keys }
  let data = Unmanaged<CFData>.fromOpaque(property).takeUnretainedValue()
  guard let bytes = CFDataGetBytePtr(data) else { return keys }
  let layout = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
  let keyboardType = UInt32(LMGetKbdType())
  let shift = UInt32((shiftKey >> 8) & 0xFF)
  let option = UInt32((optionKey >> 8) & 0xFF)
  let states: [(UInt32, [String])] = [
    (0, []), (shift, ["shift"]), (option, ["alt"]), (shift | option, ["alt", "shift"]),
  ]
  for (modifierState, modifiers) in states {
    for code in 0..<128 {
      var deadKeyState: UInt32 = 0
      var length = 0
      var characters = [UniChar](repeating: 0, count: 4)
      let status = UCKeyTranslate(
        layout, UInt16(code), UInt16(kUCKeyActionDown), modifierState, keyboardType,
        OptionBits(kUCKeyTranslateNoDeadKeysMask), &deadKeyState, characters.count, &length,
        &characters)
      guard status == 0, length > 0 else { continue }
      let text = String(utf16CodeUnits: characters, count: length)
      if keys[text] == nil {
        keys[text] = KeyStroke(code: CGKeyCode(code), modifiers: modifiers)
      }
    }
  }
  return keys
}

struct Chord {
  let modifiers: [String]
  let code: CGKeyCode
}

// A chord is `<modifiers>|code:<key code>` or `<modifiers>|char:<character>`.
func parseChord(_ spec: String, layout: [String: KeyStroke]) -> Chord {
  guard let bar = spec.firstIndex(of: "|") else { fail("Invalid chord: \(spec)", code: 2) }
  var modifiers = modifierList(String(spec[..<bar]))
  let key = String(spec[spec.index(after: bar)...])
  if key.hasPrefix("code:"), let code = UInt16(key.dropFirst(5)), code < 128 {
    return Chord(modifiers: modifiers, code: code)
  }
  if key.hasPrefix("char:") {
    let character = String(key.dropFirst(5))
    if let stroke = layout[character] ?? ansiKeys[character] {
      for modifier in stroke.modifiers where !modifiers.contains(modifier) {
        modifiers.append(modifier)
      }
      return Chord(modifiers: modifiers, code: stroke.code)
    }
  }
  fail("Unsupported key: \(key)", code: 2)
}

func press(_ chord: Chord) {
  withModifiers(chord.modifiers) { flags in tapKey(chord.code, flags: flags) }
}

func typeText(_ text: String) {
  for character in text {
    switch character {
    case "\n", "\r", "\r\n":
      tapKey(36)
    case "\t":
      tapKey(48)
    default:
      let units = Array(String(character).utf16)
      for down in [true, false] {
        let event = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: down)
        event?.flags = []
        units.withUnsafeBufferPointer { buffer in
          event?.keyboardSetUnicodeString(
            stringLength: buffer.count, unicodeString: buffer.baseAddress)
        }
        post(event)
      }
    }
    pause(8)
  }
}

// MARK: Windows

func onScreenWindows() -> [[String: Any]] {
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  return CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
}

func windowBounds(_ entry: [String: Any]) -> CGRect? {
  guard let dictionary = entry[kCGWindowBounds as String] as? NSDictionary else { return nil }
  return CGRect(dictionaryRepresentation: dictionary as CFDictionary)
}

// Only windows on the main display, the one the provider captures and drives.
func listWindows() -> [[String: Any]] {
  let screen = CGDisplayBounds(CGMainDisplayID())
  let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier
  var focusedSeen = false
  var windows: [[String: Any]] = []
  // Front to back, so the first window of the frontmost app has focus.
  for entry in onScreenWindows() {
    guard (entry[kCGWindowLayer as String] as? Int) == 0,
      let number = entry[kCGWindowNumber as String] as? Int,
      let pid = entry[kCGWindowOwnerPID as String] as? Int,
      let bounds = windowBounds(entry)
    else { continue }
    if let alpha = entry[kCGWindowAlpha as String] as? Double, alpha <= 0 { continue }
    let focused = !focusedSeen && frontmost == pid_t(pid)
    if focused { focusedSeen = true }
    if !bounds.intersects(screen) { continue }
    windows.append([
      "id": String(number),
      "pid": pid,
      "app": entry[kCGWindowOwnerName as String] as? String ?? "",
      "title": entry[kCGWindowName as String] as? String ?? "",
      "x": Double(bounds.origin.x),
      "y": Double(bounds.origin.y),
      "width": Double(bounds.width),
      "height": Double(bounds.height),
      "focused": focused,
    ])
  }
  return windows
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
    return nil
  }
  return value
}

func frame(of window: AXUIElement) -> CGRect? {
  guard let position = attribute(window, kAXPositionAttribute),
    let size = attribute(window, kAXSizeAttribute),
    CFGetTypeID(position) == AXValueGetTypeID(),
    CFGetTypeID(size) == AXValueGetTypeID()
  else { return nil }
  var origin = CGPoint.zero
  var extent = CGSize.zero
  guard AXValueGetValue(position as! AXValue, .cgPoint, &origin),
    AXValueGetValue(size as! AXValue, .cgSize, &extent)
  else { return nil }
  return CGRect(origin: origin, size: extent)
}

func matchingWindow(_ app: AXUIElement, bounds: CGRect, title: String) -> AXUIElement? {
  guard let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] else { return nil }
  var byTitle: AXUIElement?
  for window in windows {
    if let frame = frame(of: window), frame.integral == bounds.integral { return window }
    if byTitle == nil, !title.isEmpty, attribute(window, kAXTitleAttribute) as? String == title {
      byTitle = window
    }
  }
  return byTitle
}

func focusWindow(_ id: String) {
  guard let number = Int(id) else { fail("Invalid window id: \(id)", code: 2) }
  guard
    let entry = onScreenWindows().first(where: {
      ($0[kCGWindowNumber as String] as? Int) == number
    }),
    let pid = entry[kCGWindowOwnerPID as String] as? Int
  else { fail("Window \(id) is not on screen") }
  let app = AXUIElementCreateApplication(pid_t(pid))
  AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
  NSRunningApplication(processIdentifier: pid_t(pid))?.activate(options: [.activateIgnoringOtherApps])
  guard let bounds = windowBounds(entry),
    let window = matchingWindow(
      app, bounds: bounds, title: entry[kCGWindowName as String] as? String ?? "")
  else { fail("Window \(id) exposes no accessibility element to raise") }
  AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
  let raised = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
  if raised != .success { fail("Could not raise window \(id) (AXError \(raised.rawValue))") }
  // Activation is asynchronous; report failure rather than letting later input
  // land in another app.
  let deadline = Date().addingTimeInterval(2)
  while Date() < deadline {
    if attribute(app, kAXFrontmostAttribute) as? Bool == true { return }
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
  }
  fail("Window \(id) did not come to the front")
}

// MARK: Launch

func applicationURL(_ target: String) -> URL? {
  let files = FileManager.default
  if target.contains("/") {
    return files.fileExists(atPath: target) ? URL(fileURLWithPath: target) : nil
  }
  let name = target.hasSuffix(".app") ? target : target + ".app"
  let directories = [
    "/Applications", "/Applications/Utilities", "/System/Applications",
    "/System/Applications/Utilities", NSHomeDirectory() + "/Applications",
  ]
  for directory in directories {
    let path = directory + "/" + name
    if files.fileExists(atPath: path) { return URL(fileURLWithPath: path) }
  }
  return NSWorkspace.shared.urlForApplication(withBundleIdentifier: target)
}

func launchApplication(_ target: String, arguments: [String]) {
  guard let url = applicationURL(target) else { fail("No application named \(target)") }
  let configuration = NSWorkspace.OpenConfiguration()
  configuration.arguments = arguments
  configuration.activates = true
  let outcome = LaunchOutcome()
  NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
    outcome.finish(pid: app?.processIdentifier ?? 0, failure: error?.localizedDescription)
  }
  let deadline = Date().addingTimeInterval(30)
  var result = outcome.result()
  while result == nil && Date() < deadline {
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    result = outcome.result()
  }
  guard let finished = result else { fail("Timed out opening \(target)") }
  if let failure = finished.failure { fail(failure) }
  if finished.pid <= 0 { fail("\(target) opened without a process id") }
  emit(["pid": Int(finished.pid)])
}

// The completion handler runs on another queue.
final class LaunchOutcome: @unchecked Sendable {
  private let lock = NSLock()
  private var value: (pid: pid_t, failure: String?)?

  func finish(pid: pid_t, failure: String?) {
    lock.lock()
    value = (pid, failure)
    lock.unlock()
  }

  func result() -> (pid: pid_t, failure: String?)? {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
}

// MARK: Main

let arguments = Array(CommandLine.arguments.dropFirst())
guard let command = arguments.first else {
  fail("usage: klex-desktop-helper <command> [arguments]", code: 2)
}
let rest = Array(arguments.dropFirst())

func expectArguments(_ expected: Int) {
  if rest.count != expected { fail("\(command) takes \(expected) arguments", code: 2) }
}

func point(_ x: String, _ y: String) -> CGPoint {
  return CGPoint(x: number(x), y: number(y))
}

switch command {
case "version":
  emit(["version": helperVersion])
case "probe":
  var result = displayInfo()
  result["session"] = CGSessionCopyCurrentDictionary() != nil
  result["screenRecording"] = CGPreflightScreenCaptureAccess()
  result["accessibility"] = AXIsProcessTrusted()
  emit(result)
case "display":
  emit(displayInfo())
case "move":
  expectArguments(2)
  requireAccessibility()
  moveMouse(point(rest[0], rest[1]))
case "click":
  expectArguments(5)
  let button = mouseButton(rest[2])
  let clicks = positiveCount(rest[3])
  let modifiers = modifierList(rest[4])
  requireAccessibility()
  click(point(rest[0], rest[1]), button, clicks: clicks, modifiers: modifiers)
case "drag":
  expectArguments(5)
  let button = mouseButton(rest[4])
  requireAccessibility()
  drag(from: point(rest[0], rest[1]), to: point(rest[2], rest[3]), button)
case "scroll":
  expectArguments(4)
  let steps = positiveCount(rest[3])
  requireAccessibility()
  scroll(point(rest[0], rest[1]), direction: rest[2], steps: steps)
case "type":
  expectArguments(0)
  guard let text = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8)
  else { fail("Text must be UTF-8", code: 2) }
  requireAccessibility()
  typeText(text)
case "key":
  if rest.isEmpty { fail("key takes at least one chord", code: 2) }
  let layout = layoutKeys()
  let chords = rest.map { parseChord($0, layout: layout) }
  requireAccessibility()
  for (index, chord) in chords.enumerated() {
    if index > 0 { pause(40) }
    press(chord)
  }
case "windows":
  emit(listWindows())
case "focus":
  expectArguments(1)
  requireAccessibility()
  focusWindow(rest[0])
case "launch-app":
  if rest.isEmpty { fail("launch-app takes an application", code: 2) }
  launchApplication(rest[0], arguments: Array(rest.dropFirst()))
default:
  fail("Unknown command: \(command)", code: 2)
}
