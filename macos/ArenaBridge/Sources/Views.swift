import SwiftUI
import AppKit

// MARK: - window

struct ContentView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            Header()
            Divider()
            ScrollView {
                VStack(spacing: 14) {
                    StatusCard()
                    ActionsCard()
                    ApprovalsCard()
                    LogCard()
                }
                .padding(16)
            }
            if let notice = model.notice {
                Banner(text: notice, kind: .ok)
            } else if let failure = model.failure {
                Banner(text: failure, kind: .error)
            }
        }
        .sheet(isPresented: $model.showSetup) {
            SetupView()
                .environmentObject(model)
        }
        .sheet(item: $model.shownArtifact) { artifact in
            ArtifactView(artifact: artifact)
        }
        .onReceive(Timer.publish(every: 6, on: .main, in: .common).autoconnect()) { _ in
            Task { await model.refresh() }
        }
    }
}

// MARK: - header

struct Header: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(model.running ? Color.green : (model.serviceInstalled ? Color.orange : Color.secondary))
                .frame(width: 10, height: 10)
            VStack(alignment: .leading, spacing: 1) {
                Text("Arena Bridge")
                    .font(.headline)
                Text(model.running ? "running on \(model.device)" : "stopped")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if model.busy { ProgressView().controlSize(.small) }
            Button {
                Task { await model.refresh() }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.borderless)
            .help("Refresh")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}

// MARK: - cards

struct Card<Content: View>: View {
    let title: String
    let symbol: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(title, systemImage: symbol)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color(nsColor: .controlBackgroundColor))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
        )
    }
}

struct StatusCard: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Card(title: "Status", symbol: "waveform.path.ecg") {
            VStack(alignment: .leading, spacing: 8) {
                row("State", model.running ? "running" : "stopped")
                row("Version", model.version)
                row("Mode", model.mode)
                row("Tools", model.toolCount == 0 ? "—" : "\(model.toolCount)")
                HStack(alignment: .firstTextBaseline) {
                    Text("Address")
                        .foregroundStyle(.secondary)
                        .frame(width: 90, alignment: .leading)
                    Text(model.url ?? "not set")
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    Button {
                        model.copyURL()
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                    .buttonStyle(.borderless)
                    .disabled(model.url == nil)
                    .help("Copy")
                }
                HStack(alignment: .firstTextBaseline) {
                    Text("Notifications")
                        .foregroundStyle(.secondary)
                        .frame(width: 90, alignment: .leading)
                    Text(model.notificationsAllowed ? "on" : "off — enable them in System Settings › Notifications")
                    Spacer()
                }
                HStack(alignment: .firstTextBaseline) {
                    Text("Telegram")
                        .foregroundStyle(.secondary)
                        .frame(width: 90, alignment: .leading)
                    Text(model.telegramEnabled
                         ? "connected" + (model.telegramChats.isEmpty ? "" : " · \(model.telegramChats.joined(separator: ", "))")
                         : "not configured")
                    Spacer()
                }
            }
        }
    }

    func row(_ title: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .foregroundStyle(.secondary)
                .frame(width: 90, alignment: .leading)
            Text(value)
            Spacer()
        }
    }
}

struct ActionsCard: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Card(title: "Control", symbol: "switch.2") {
            HStack(spacing: 10) {
                Button {
                    model.start()
                } label: {
                    Label("Start", systemImage: "play.fill")
                }
                .disabled(model.running)

                Button {
                    model.stop()
                } label: {
                    Label("Stop", systemImage: "stop.fill")
                }
                .disabled(!model.running)

                Button {
                    model.showSetup = true
                } label: {
                    Label("Setup…", systemImage: "gearshape")
                }

                Button {
                    model.copyPrompt()
                } label: {
                    Label("Copy the agent prompt", systemImage: "doc.on.doc")
                }

                Spacer()
            }
            Divider()
            HStack(spacing: 10) {
                Image(systemName: "timer")
                    .foregroundStyle(.secondary)
                Text("Trust window")
                    .foregroundStyle(.secondary)
                if model.trustEnabled {
                    Text("active — \(model.trustRemainingText) left")
                        .foregroundStyle(.green)
                    if !model.trustTools.isEmpty {
                        Text(model.trustTools.joined(separator: ", "))
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    Button("Close") {
                        model.closeTrust()
                    }
                } else {
                    Text("closed — every action needs your decision")
                        .foregroundStyle(.secondary)
                    Button("Open for 3 h") {
                        model.openTrust(hours: 3)
                    }
                    .help("The agent may act without asking for the next 3 hours")
                }
                Spacer()
            }
            .font(.callout)
        }
    }
}

struct ApprovalsCard: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Card(title: model.pendingCount == 0 ? "Approvals" : "Approvals (\(model.pendingCount))", symbol: "hand.raised") {
            if model.approvals.isEmpty {
                Text("No pending requests. The agent can act freely inside the trusted window.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                VStack(spacing: 8) {
                    ForEach(model.approvals) { approval in
                        HStack(alignment: .top, spacing: 10) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(approval.tool).font(.callout.weight(.semibold))
                                if !approval.summary.isEmpty {
                                    Text(approval.summary)
                                        .font(.system(.caption, design: .monospaced))
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                }
                                Text(approval.created.formatted(date: .omitted, time: .shortened))
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 4) {
                                HStack(spacing: 6) {
                                    Button("Approve") { model.decide(approval, approve: true) }
                                        .buttonStyle(.borderedProminent)
                                    Button("Deny") { model.decide(approval, approve: false) }
                                        .buttonStyle(.bordered)
                                }
                                Button("Approve for 3 h") { model.decide(approval, approve: true, trustHours: 3) }
                                    .buttonStyle(.bordered)
                                    .help("Approve and trust this tool for the next 3 hours")
                            }
                        }
                        if approval.id != model.approvals.last?.id { Divider() }
                    }
                }
            }
        }
    }
}

struct LogCard: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Card(title: "Work log", symbol: "list.bullet.rectangle") {
            HStack {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Filter by tool", text: $model.filter)
                    .textFieldStyle(.plain)
                if !model.filter.isEmpty {
                    Button {
                        model.filter = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
                }
                Button {
                    model.saveLog()
                } label: {
                    Label("Save…", systemImage: "square.and.arrow.down")
                }
                .buttonStyle(.bordered)
            }
            if model.visibleEntries.isEmpty {
                Text("The log is empty.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 3) {
                        ForEach(model.visibleEntries) { entry in
                            LogLine(entry: entry) { artifact in
                                model.shownArtifact = artifact
                            }
                        }
                    }
                }
                .frame(height: 150)
                .background(Color(nsColor: .textBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
    }
}

struct LogLine: View {
    let entry: LogEntry
    let show: (Artifact) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(entry.time.formatted(date: .omitted, time: .standard))
                    .foregroundStyle(.secondary)
                Text(entry.tool)
                    .frame(width: 120, alignment: .leading)
                Text(entry.status)
                    .foregroundStyle(entry.status == "ok" ? Color.green : Color.orange)
                    .frame(width: 90, alignment: .leading)
                Text(entry.detail)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
                ForEach(entry.artifacts) { artifact in
                    Button {
                        show(artifact)
                    } label: {
                        Text(artifact.name)
                    }
                    .buttonStyle(.borderless)
                    .font(.system(size: 10))
                    .help("Open \(artifact.name)")
                }
            }
            if !entry.summary.isEmpty {
                Text(entry.summary)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.leading, 18)
            }
        }
        .font(.system(size: 11, design: .monospaced))
        .padding(.horizontal, 6)
    }
}

/// A screenshot or an accessibility tree, opened from the log.
struct ArtifactView: View {
    let artifact: Artifact
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var image: NSImage?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(artifact.name)
                    .font(.headline)
                Text(artifact.bytes > 0 ? "\(artifact.bytes) bytes" : "")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Close") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
            } else {
                ScrollView([.vertical, .horizontal]) {
                    Text(text.isEmpty ? "The file is empty or cannot be read." : text)
                        .font(.system(size: 11, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(16)
        .frame(width: 820, height: 620)
        .onAppear {
            if artifact.isImage {
                image = NSImage(contentsOfFile: artifact.path)
            }
            if let data = FileManager.default.contents(atPath: artifact.path) {
                text = String(data: data, encoding: .utf8) ?? ""
            }
        }
    }
}

// MARK: - banners

struct Banner: View {
    enum Kind { case ok, error }
    let text: String
    let kind: Kind

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: kind == .ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
            Text(text).font(.callout)
            Spacer()
        }
        .foregroundStyle(kind == .ok ? Color.green : Color.red)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(kind == .ok ? Color.green.opacity(0.08) : Color.red.opacity(0.08))
    }
}

// MARK: - setup

struct SetupView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var tunnel = "ngrok"
    @State private var domain = ""
    @State private var authtoken = ""
    @State private var roots = ""
    @State private var telegramToken = ""
    @State private var telegramChat = ""
    @State private var working = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Setup")
                .font(.title3.weight(.semibold))
            Text("Everything is optional: fill only what you need.")
                .font(.callout)
                .foregroundStyle(.secondary)

            Form {
                Section("Public address") {
                    Picker("Tunnel", selection: $tunnel) {
                        Text("ngrok").tag("ngrok")
                        Text("cloudflared").tag("cloudflared")
                    }
                    TextField("Reserved domain (ngrok)", text: $domain)
                    SecureField("ngrok authtoken", text: $authtoken)
                }
                Section("Folders the agent may touch") {
                    TextEditor(text: $roots)
                        .frame(height: 70)
                        .font(.system(.caption, design: .monospaced))
                    Text("One folder per line, for example /Users/me/Documents")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Section("Telegram") {
                    SecureField("Bot token", text: $telegramToken)
                    TextField("Chat id", text: $telegramChat)
                }
            }
            .formStyle(.grouped)

            if let error {
                Text(error)
                    .font(.callout)
                    .foregroundStyle(.red)
            }

            HStack {
                if working { ProgressView().controlSize(.small) }
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Save and start") { apply() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(working)
            }
        }
        .padding(18)
        .frame(width: 520, height: 520)
        .onAppear(perform: load)
    }

    private func load() {
        let config = BridgeConfig.load()
        roots = config.roots.joined(separator: "\n")
        if let url = config.publicUrl, url.contains("ngrok") { domain = url }
        telegramChat = config.telegramChats.first ?? ""
    }

    private func apply() {
        working = true
        error = nil
        let folderList = roots.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        var arguments = ["init"]
        for folder in folderList { arguments += ["--root", folder] }
        let initResult = Bridge.run(arguments)
        if initResult.code != 0 {
            error = initResult.output.trimmingCharacters(in: .whitespacesAndNewlines)
            working = false
            return
        }
        if !telegramToken.isEmpty && !telegramChat.isEmpty {
            let result = Bridge.run(["telegram", "setup", "--token", telegramToken, "--chat-id", telegramChat])
            if result.code != 0 {
                error = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
                working = false
                return
            }
        }
        var service = ["service", "install", "--bin", tunnel]
        if !domain.isEmpty { service += ["--domain", domain] }
        if !authtoken.isEmpty { service += ["--authtoken", authtoken] }
        let serviceResult = Bridge.run(service)
        if serviceResult.code != 0 {
            error = serviceResult.output.trimmingCharacters(in: .whitespacesAndNewlines)
            working = false
            return
        }
        Bridge.start()
        working = false
        dismiss()
        Task { await model.refresh() }
    }
}
