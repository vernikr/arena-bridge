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
            TimelineView(.animation(minimumInterval: 0.12)) { timeline in
                Image(nsImage: MenuBarStatusImage.ellipsis(at: timeline.date.timeIntervalSinceReferenceDate))
            }
            .frame(width: 22, height: 22)
            .accessibilityLabel("Bridge changing state")
        } else {
            Image(nsImage: MenuBarStatusImage.link(off: !model.running))
                .frame(width: 22, height: 22)
                .accessibilityLabel(model.running ? "Bridge running" : "Bridge stopped")
        }
    }
}

private enum MenuBarStatusImage {
    static func link(off: Bool) -> NSImage {
        let image = NSImage(size: NSSize(width: 22, height: 22), flipped: false) { rect in
            let p: (CGFloat, CGFloat) -> NSPoint = { x, y in NSPoint(x: x, y: 22 - y) }
            let links = NSBezierPath()
            links.move(to: p(9, 17))
            links.line(to: p(7, 17))
            links.curve(to: p(7, 7), controlPoint1: p(2, 17), controlPoint2: p(2, 7))
            if !off { links.line(to: p(9, 7)) }
            links.move(to: p(15, 7))
            links.line(to: p(17, 7))
            if off {
                links.curve(to: p(21, 15), controlPoint1: p(21.8, 7), controlPoint2: p(22, 11.7))
            } else {
                links.curve(to: p(17, 17), controlPoint1: p(22, 7), controlPoint2: p(22, 17))
                links.line(to: p(15, 17))
            }
            links.move(to: p(8, 12))
            links.line(to: p(off ? 12 : 16, 12))
            links.lineWidth = 2
            links.lineCapStyle = .round
            links.lineJoinStyle = .round
            NSColor.labelColor.setStroke()
            links.stroke()
            if off {
                let slash = NSBezierPath()
                slash.move(to: p(3, 3))
                slash.line(to: p(21, 21))
                slash.lineWidth = 2
                slash.lineCapStyle = .round
                NSColor.labelColor.setStroke()
                slash.stroke()
            }
            return true
        }
        image.isTemplate = true
        return image
    }

    static func ellipsis(at time: TimeInterval) -> NSImage {
        let image = NSImage(size: NSSize(width: 22, height: 22), flipped: false) { _ in
            let phase = time * 4
            for index in 0..<3 {
                let opacity = 0.25 + 0.75 * max(0, sin(phase - Double(index) * 0.9))
                NSColor.labelColor.withAlphaComponent(CGFloat(opacity)).setFill()
                NSBezierPath(ovalIn: NSRect(x: 6 + CGFloat(index) * 5, y: 9, width: 3, height: 3)).fill()
            }
            return true
        }
        image.isTemplate = true
        return image
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
