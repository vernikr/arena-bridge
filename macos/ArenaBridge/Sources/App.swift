import SwiftUI
import AppKit

@main
struct ArenaBridgeApp: App {
    @NSApplicationDelegateAdaptor(ArenaBridgeAppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        Notifier.shared.start()
    }

    var body: some Scene {
        WindowGroup(id: "main") {
            ContentView()
                .environmentObject(model)
                .frame(minWidth: 600, minHeight: 680)
                .task { await model.refresh() }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { Task { await model.refresh() } }
                }
        }
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandMenu("Bridge") {
                Button("Refresh") { Task { await model.refresh() } }
                    .keyboardShortcut("r", modifiers: .command)
                Button("Setup…") { model.showSetup = true }
                    .keyboardShortcut(",", modifiers: .command)
                Divider()
                Button("Start") { model.start() }
                Button("Stop") { model.stop() }
            }
        }
        MenuBarExtra {
            MenuBarView()
                .environmentObject(model)
        } label: {
            MenuBarIcon()
                .environmentObject(model)
        }
        .menuBarExtraStyle(.menu)
    }
}

final class ArenaBridgeAppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}
