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
                 : "This build is ad-hoc signed. macOS may reset the permissions after an update.")
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

/// One-time setup of a signing certificate, and the sequence that keeps the permissions after each build.
struct SigningGuideView: View {
    @EnvironmentObject var model: AppModel

    static let identity = "Arena Bridge Local"
    static let command = "ARENA_SIGN_IDENTITY=\"Arena Bridge Local\" bash macos/ArenaBridge/build.sh"

    private static let setup: [String] = [
        "Open Keychain Access: press ⌘Space, type Keychain Access, press Return.",
        "In the menu bar choose Keychain Access → Certificate Assistant → Create a Certificate…",
        "Name: Arena Bridge Local (click the name below to copy it, then paste). Identity Type: Self Signed Root. Certificate Type: Code Signing. Leave the other options off. Click Create, then Done.",
        "Find the certificate: in Keychain Access, under Keychains on the left, click login. Type Arena Bridge Local in the search box at the top right. Three items appear: a certificate, a public key and a private key. Double-click the one whose Kind is certificate.",
        "In that window open the Trust section. Set When using this certificate to Always Trust. Close the window and enter your Mac password.",
    ]

    private static let sequence: [String] = [
        "You do not download or build anything yourself. In the chat, write to the agent: \"Rebuild Arena Bridge with the certificate Arena Bridge Local and install it.\"",
        "The first install with the certificate resets the permissions once more. Grant Screen Recording and Accessibility again with the Fix buttons, then quit with ⌘Q and open the app.",
        "From then on every rebuild with the same certificate keeps the permissions. Do not rename the certificate.",
    ]

    private static let trouble: [String] = [
        "The build says \"signing failed\": the name must match exactly, and the certificate must show Always Trust.",
        "The certificate is not in the list: look under login → My Certificates. If it is missing, create it again.",
        "Release downloads from GitHub are not signed with this certificate. Their permissions still reset after an update.",
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Keep permissions after updates")
                .font(.title3.weight(.semibold))
                .textSelection(.enabled)
            Text(AppModel.hasCertificate
                 ? "This build is signed with a certificate."
                 : "This build is ad-hoc signed. Its permissions reset after each new build until the steps below are done.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text("1. Create the certificate (once)")
                        .font(.headline)
                        .textSelection(.enabled)
                    ForEach(Array(Self.setup.enumerated()), id: \.offset) { index, step in
                        Text("\(index + 1). \(step)")
                            .font(.callout)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    CopyRow(text: Self.identity)
                    Text("2. Use the certificate for every build")
                        .font(.headline)
                        .textSelection(.enabled)
                    ForEach(Array(Self.sequence.enumerated()), id: \.offset) { index, step in
                        Text("\(index + 1). \(step)")
                            .font(.callout)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text("For developers only: the build command in the repository folder")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                    CopyRow(text: Self.command)
                    Text("If something fails")
                        .font(.headline)
                        .textSelection(.enabled)
                    ForEach(Array(Self.trouble.enumerated()), id: \.offset) { _, line in
                        Text("• \(line)")
                            .font(.callout)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
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
