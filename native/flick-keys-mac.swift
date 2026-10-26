// Flick media keys (macOS).
//
// The phone as a remote: pc/keys.js starts this once and writes one key name per line on its standard input; each is
// pressed (down, then up) as a media key, so the player in front, the volume and macOS' own volume display react as if
// the user had pressed the key on a keyboard. Runs until its input closes (EOF), then exits 0.
//
//   play | next | prev | vol-up | vol-down | mute
//
// Prints one line per input line: "sent <key>", "unknown <up to 32 printable characters>", or "untrusted <key>": macOS
// lets a program press keys only once the user has allowed it in System Settings > Privacy & Security > Accessibility
// (for Flick, which starts this). The first such key also brings up macOS' own prompt, with a button to that page.
//
// Build (build_mac.sh does this, one program for both kinds of Mac):
//   swiftc -O -swift-version 5 -target arm64-apple-macos13 -o flick-keys-arm64 flick-keys-mac.swift
//   swiftc -O -swift-version 5 -target x86_64-apple-macos13 -o flick-keys-x64 flick-keys-mac.swift
//   lipo -create -output flick-keys flick-keys-arm64 flick-keys-x64
import AppKit
import ApplicationServices

// NX_KEYTYPE_* (IOKit/hidsystem/ev_keymap.h)
let keys: [String: Int32] = ["play": 16, "next": 17, "prev": 18, "vol-up": 0, "vol-down": 1, "mute": 7]

// A media key is a "system defined" event of subtype 8 (NX_SUBTYPE_AUX_CONTROL_BUTTONS): data1 holds the key in its
// upper 16 bits and its state (0xA down, 0xB up) in the 8 bits below
func post(_ code: Int32, down: Bool) -> Bool {
    let state: Int32 = down ? 0xA : 0xB
    guard let event = NSEvent.otherEvent(with: .systemDefined, location: .zero,
                                         modifierFlags: NSEvent.ModifierFlags(rawValue: UInt(state) << 8),
                                         timestamp: 0, windowNumber: 0, context: nil, subtype: 8,
                                         data1: Int((code << 16) | (state << 8)), data2: -1),
          let cg = event.cgEvent else { return false }
    cg.post(tap: .cghidEventTap)
    return true
}

var asked = false
func press(_ name: String, _ code: Int32) {
    if !AXIsProcessTrusted() {
        if !asked {
            asked = true
            // the option's name is the value of kAXTrustedCheckOptionPrompt
            _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
        }
        print("untrusted \(name)")
        return
    }
    if post(code, down: true) && post(code, down: false) { print("sent \(name)") } else { print("error \(name)") }
}

setvbuf(stdout, nil, _IOLBF, 0)          // one line at a time: keys.js reads them as they come
while let raw = readLine(strippingNewline: true) {
    let line = raw.trimmingCharacters(in: CharacterSet(charactersIn: " \t\r"))
    if line.isEmpty { continue }
    if let code = keys[line] { press(line, code); continue }
    // show it safely: printable ASCII only
    let shown = String(line.unicodeScalars.prefix(32).map { $0.value >= 0x20 && $0.value < 0x7f ? Character($0) : "?" })
    print("unknown \(shown)\(line.unicodeScalars.count > 32 ? "..." : "")")
}
exit(0)
