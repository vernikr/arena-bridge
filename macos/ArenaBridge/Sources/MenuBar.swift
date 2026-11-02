import SwiftUI
import AppKit

struct MenuBarView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button(model.transitioning ? (model.operation?.starting == true ? "Starting…" : "Stopping…") : (model.running ? "Stop" : "Start")) {
            model.toggleService()
        }
        .disabled(model.transitioning)

        Button("Copy Prompt") {
            model.copyPrompt()
        }

        Divider()

        Button("Open") {
            openMainWindow()
        }

        Button("Quit") {
            NSApp.terminate(nil)
        }
    }

    private func openMainWindow() {
        if MainWindowLifecycle.shared.showExistingWindow() { return }
        MainWindowLifecycle.shared.prepareToOpen()
        openWindow(id: "main")
    }
}

struct MenuBarIcon: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        if model.transitioning {
            EllipsisIcon()
                .foregroundStyle(.secondary)
        } else {
            Link2Icon(off: !model.running)
                .foregroundStyle(model.running ? Color.green : Color.secondary)
        }
    }
}

/// A compact link-2 icon based on the Lucide 24x24 geometry.
struct Link2Icon: View {
    let off: Bool
    private let labelColor = Color(nsColor: .labelColor)

    var body: some View {
        Canvas { context, size in
            let scale = min(size.width, size.height) / 24
            let point: (CGFloat, CGFloat) -> CGPoint = { x, y in
                CGPoint(x: x * scale + (size.width - 24 * scale) / 2,
                        y: y * scale + (size.height - 24 * scale) / 2)
            }
            var links = Path()
            links.move(to: point(9, 17))
            links.addLine(to: point(7, 17))
            links.addCurve(to: point(7, 7), control1: point(2, 17), control2: point(2, 7))
            if !off {
                links.addLine(to: point(9, 7))
            }
            links.move(to: point(15, 7))
            links.addLine(to: point(17, 7))
            if off {
                links.addCurve(to: point(21, 15), control1: point(21.8, 7), control2: point(22, 11.7))
            } else {
                links.addCurve(to: point(17, 17), control1: point(22, 7), control2: point(22, 17))
                links.addLine(to: point(15, 17))
            }
            links.move(to: point(8, 12))
            links.addLine(to: point(off ? 12 : 16, 12))
            let style = StrokeStyle(lineWidth: 2 * scale, lineCap: .round, lineJoin: .round)
            context.stroke(links, with: .color(labelColor), style: style)

            if off {
                var slash = Path()
                slash.move(to: point(3, 3))
                slash.addLine(to: point(21, 21))
                context.stroke(slash, with: .color(labelColor), style: style)
            }
        }
        .frame(width: 22, height: 22)
        .accessibilityLabel(off ? "Bridge stopped" : "Bridge running")
    }
}

/// Animated three-dot indicator used while the service is changing state.
struct EllipsisIcon: View {
    private let labelColor = Color(nsColor: .labelColor)

    var body: some View {
        TimelineView(.animation(minimumInterval: 0.12)) { timeline in
            let phase = timeline.date.timeIntervalSinceReferenceDate * 4
            HStack(spacing: 2.5) {
                ForEach(0..<3, id: \.self) { index in
                    let opacity = 0.25 + 0.75 * max(0, sin(phase - Double(index) * 0.9))
                    Circle()
                        .fill(labelColor)
                        .frame(width: 3, height: 3)
                        .opacity(opacity)
                }
            }
            .frame(width: 22, height: 22)
        }
        .accessibilityLabel("Bridge changing state")
    }
}

struct MainWindowAccessor: NSViewRepresentable {
    func makeNSView(context: Context) -> MainWindowMarker {
        MainWindowMarker()
    }

    func updateNSView(_ nsView: MainWindowMarker, context: Context) {}
}

final class MainWindowMarker: NSView {
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let window {
            MainWindowLifecycle.shared.register(window)
        }
    }
}

@MainActor
final class MainWindowLifecycle {
    static let shared = MainWindowLifecycle()

    private weak var mainWindow: NSWindow?

    private init() {
        NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let window = notification.object as? NSWindow else { return }
            Task { @MainActor [weak self] in
                self?.windowWillClose(window)
            }
        }
    }

    func register(_ window: NSWindow) {
        mainWindow = window
    }

    func prepareToOpen() {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    func showExistingWindow() -> Bool {
        guard let window = mainWindow else { return false }
        prepareToOpen()
        window.makeKeyAndOrderFront(nil)
        return true
    }

    private func windowWillClose(_ window: NSWindow) {
        guard mainWindow === window else { return }
        mainWindow = nil
        NSApp.setActivationPolicy(.accessory)
    }
}
