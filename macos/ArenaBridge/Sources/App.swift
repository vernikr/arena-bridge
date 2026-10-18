import SwiftUI

@main
struct ArenaBridgeApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                .frame(minWidth: 600, minHeight: 680)
                .task { await model.refresh() }
        }
        .windowTitle("Arena Bridge")
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandMenu("Bridge") {
                Button("Refresh") { Task { await model.refresh() } }
                    .keyboardShortcut("r", modifiers: .command)
                Button("Setup…") { model.showSetup = true }
                    .keyboardShortcut(",", modifiers: .command)
                Divider()
                Button("Start") { Task { await model.start() } }
                Button("Stop") { Task { await model.stop() } }
            }
        }
    }
}
