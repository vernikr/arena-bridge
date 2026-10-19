import SwiftUI

// Wave 4 polish: status in the menu bar (optional, does not replace WindowGroup).
// Shows pending approvals count and trust window remaining. The main window stays primary.
// To enable, add `MenuBarExtra` scene to App.swift when $99 Developer ID flow is ready.

struct MenuBarView: View {
    var pending: Int = 0
    var trustRemaining: Int = 0
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Arena Bridge — \(pending) pending")
            if trustRemaining > 0 { Text("Trust: \(trustRemaining/3600)h \((trustRemaining%3600)/60)m)") }
            Divider()
            Button("Open Arena Bridge") { NSApp.activate(ignoringOtherApps: true); if let w = NSApp.windows.first { w.makeKeyAndOrderFront(nil) } }
            Button("Quit") { NSApp.terminate(nil) }
        }.padding(8)
    }
}
