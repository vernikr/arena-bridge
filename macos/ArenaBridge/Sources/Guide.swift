import AppKit
import SwiftUI

/// Opens a guide in its own window. The window floats above the other windows, can be resized,
/// and stays open while the app is in the background.
@MainActor
enum GuideWindow {
    private static var windows: [String: NSWindow] = [:]

    static func show<Content: View>(id: String, title: String, size: NSSize, @ViewBuilder content: () -> Content) {
        if let window = windows[id], window.isVisible {
            window.makeKeyAndOrderFront(nil)
            return
        }
        let window = NSPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .resizable, .utilityWindow],
            backing: .buffered,
            defer: false
        )
        window.title = title
        window.level = .floating
        window.hidesOnDeactivate = false
        window.isReleasedWhenClosed = false
        window.contentMinSize = NSSize(width: 480, height: 380)
        window.contentView = NSHostingView(rootView: content())
        window.center()
        windows[id] = window
        window.makeKeyAndOrderFront(nil)
    }

    static func close(_ id: String) {
        windows[id]?.close()
        windows[id] = nil
    }
}

/// A line that copies itself to the clipboard when clicked.
struct CopyRow: View {
    let text: String
    @State private var copied = false

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
                copied = true
                Task {
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    copied = false
                }
            } label: {
                Text(text)
                    .font(.system(size: 12, design: .monospaced))
                    .underline()
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .buttonStyle(.plain)
            .help("Click to copy")
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .foregroundStyle(copied ? Color.green : Color.secondary)
        }
    }
}

/// Guide for one macOS permission. The path is the helper that runs the screen runtime.
struct PermissionGuideView: View {
    let kind: PermissionKind
    @EnvironmentObject var model: AppModel

    static let helperPath = "/Applications/Arena Bridge.app/Contents/Helpers/arena-bridge-agent"

    private var granted: Bool? { kind == .screen ? model.screenAccess : model.accessibilityAccess }

    private var stateText: String {
        if granted == true { return "granted" }
        if granted == false { return "missing" }
        return model.permissionsCheckedAt == nil ? "not checked yet" : "no answer from the bridge; start the service"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("\(kind.title) for Arena Bridge")
                .font(.title3.weight(.semibold))
                .textSelection(.enabled)
            HStack(spacing: 8) {
                Image(systemName: granted == true ? "checkmark.circle.fill" : granted == false ? "xmark.circle.fill" : "questionmark.circle")
                    .foregroundStyle(granted == true ? Color.green : granted == false ? Color.red : Color.secondary)
                Text("\(kind.title): \(stateText)")
                Spacer()
                if model.permissionsChecking {
                    ProgressView().controlSize(.small)
                    Text("Checking…").foregroundStyle(.secondary)
                } else if let at = model.permissionsCheckedAt {
                    Text("Checked at \(at.formatted(date: .omitted, time: .standard))").foregroundStyle(.secondary)
                }
            }
            .font(.callout)
            Text("Path to add in System Settings (click to copy):")
                .font(.callout)
                .textSelection(.enabled)
            CopyRow(text: Self.helperPath)
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(kind.steps.enumerated()), id: \.offset) { index, step in
                        Text("\(index + 1). \(step)")
                            .font(.callout)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: .infinity)
            Text(AppModel.hasCertificate
                 ? "This build is signed with a certificate. Permissions normally survive updates."
                 : "This build is not signed with the project certificate. macOS may ask for this permission again after an update.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button("Open \(kind.title) settings") { openPane() }
                Button("Show app in Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: "/Applications/Arena Bridge.app")])
                }
                Button("Keep permissions after updates…") { model.openSigningGuide() }
                Spacer()
                Button("Check again") { model.checkPermissions(force: true) }
                    .disabled(model.permissionsChecking)
                Button("Done") { NSApp.keyWindow?.close() }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(minWidth: 480, minHeight: 380)
        .onAppear { model.checkPermissions(force: true) }
    }

    private func openPane() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(kind.pane)") {
            NSWorkspace.shared.open(url)
        }
    }
}

/// Explains when permissions survive an update, and what to do after one.
struct SigningGuideView: View {
    @EnvironmentObject var model: AppModel

    static let command = "ARENA_SIGN_IDENTITY=\"Arena Bridge Local\" bash macos/ArenaBridge/build.sh"

    private static let why: [String] = [
        "macOS ties Screen Recording and Accessibility to the app's signature. An update that changes the signature makes macOS treat the app as new.",
        "Builds signed with the project certificate keep these permissions across updates. Other builds reset them.",
        "Check the release notes: a release says whether it is signed with the project certificate.",
    ]

    private static let after: [String] = [
        "Open Arena Bridge. The Control card shows any permission that is missing.",
        "Click Fix Screen Recording… and Fix Accessibility… if they appear, and follow the steps in each guide.",
        "Quit with ⌘Q and open the app again. The warning disappears when both permissions are granted.",
    ]

    private static let developer: [String] = [
        "Create a certificate once: Keychain Access → Certificate Assistant → Create a Certificate…, name Arena Bridge Local, Identity Type Self Signed Root, Certificate Type Code Signing.",
        "Set its Trust to Always Trust. The certificate is in the login keychain; find it by searching for the name.",
        "Build with this certificate. The command for the repository folder is below. Keep the name unchanged.",
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Keep permissions after updates")
                .font(.title3.weight(.semibold))
                .textSelection(.enabled)
            Text(AppModel.hasCertificate
                 ? "This build is signed with the project certificate. Its permissions normally survive updates."
                 : "This build is not signed with the project certificate. After an update macOS may ask for Screen Recording and Accessibility again.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Why")
                        .font(.headline)
                        .textSelection(.enabled)
                    ForEach(Array(Self.why.enumerated()), id: \.offset) { _, line in
                        Text("• \(line)")
                            .font(.callout)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text("After an update")
                        .font(.headline)
                        .textSelection(.enabled)
                    ForEach(Array(Self.after.enumerated()), id: \.offset) { index, step in
                        Text("\(index + 1). \(step)")
                            .font(.callout)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text("For people who build the app from source")
                        .font(.headline)
                        .textSelection(.enabled)
                    ForEach(Array(Self.developer.enumerated()), id: \.offset) { index, step in
                        Text("\(index + 1). \(step)")
                            .font(.callout)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    CopyRow(text: Self.command)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: .infinity)
            HStack {
                Spacer()
                Button("Done") { NSApp.keyWindow?.close() }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(minWidth: 520, minHeight: 460)
    }
}
