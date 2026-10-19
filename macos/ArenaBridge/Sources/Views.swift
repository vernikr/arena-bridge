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
                    if !model.approvals.isEmpty {
                        ApprovalsCard()
                    }
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
        .sheet(item: $model.detailEntry) { entry in
            EntryDetail(entry: entry)
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
                Text(AppInfo.name)
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

/// Current step of a start or stop, or the state when nothing is running.
struct StepIndicator: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        HStack(spacing: 6) {
            if let op = model.operation, let reason = op.reason {
                Image(systemName: "xmark.octagon.fill").foregroundStyle(.red)
                Text("Failed at step \(op.step)/\(op.total): \(reason)").foregroundStyle(.red)
            } else if let op = model.operation {
                ProgressView().controlSize(.small)
                Text("Step \(op.step)/\(op.total) · \(op.name)")
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text("· \(Int(context.date.timeIntervalSince(op.since))) s").foregroundStyle(.secondary)
                }
            } else if model.running {
                Image(systemName: "circle.fill").foregroundStyle(.green)
                Text(model.publicReady ? "Running · public address ready" : "Running · no public address")
            } else {
                Image(systemName: "circle").foregroundStyle(.secondary)
                Text("Stopped").foregroundStyle(.secondary)
            }
        }
        .font(.callout)
        .lineLimit(1)
    }
}

struct ActionsCard: View {
    @EnvironmentObject var model: AppModel

    private var toggleTitle: String {
        if let op = model.operation, op.reason == nil { return op.starting ? "Starting…" : "Stopping…" }
        return model.running ? "Stop" : "Start"
    }

    private var toggleSymbol: String {
        if model.transitioning { return "hourglass" }
        return model.running ? "stop.fill" : "play.fill"
    }

    var body: some View {
        Card(title: "Control", symbol: "switch.2") {
            HStack(spacing: 12) {
                Button {
                    model.toggleService()
                } label: {
                    Label(toggleTitle, systemImage: toggleSymbol)
                        .frame(minWidth: 96)
                }
                .buttonStyle(.borderedProminent)
                .tint(model.running ? .red : .green)
                .disabled(model.transitioning)
                StepIndicator()
                if model.operation?.starting == true, model.operation?.reason == nil {
                    Button("Cancel") { model.cancelStart() }
                        .controlSize(.small)
                }
                Spacer(minLength: 8)
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
            }
            ForEach(model.missingPermissions) { kind in
                HStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    Text("\(kind.title) is missing: \(kind.consequence).").font(.callout).lineLimit(2)
                    Spacer()
                    Button("Fix \(kind.title)…") { model.openGuide(kind) }
                        .buttonStyle(.borderedProminent)
                }
            }
            HStack(spacing: 10) {
                Image(systemName: AppModel.hasCertificate ? "checkmark.seal.fill" : "seal")
                    .foregroundStyle(AppModel.hasCertificate ? Color.green : Color.secondary)
                Text(AppModel.hasCertificate
                     ? "Signed with the project certificate: permissions survive updates."
                     : "Not signed with the project certificate: permissions may reset after an update.")
                    .font(.callout)
                    .lineLimit(2)
                Spacer()
                if !AppModel.hasCertificate {
                    Button("Keep permissions after updates…") { model.openSigningGuide() }
                }
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

    private static let levels = [("info", "All levels"), ("notice", "Notice and up"), ("warning", "Warning and up"), ("alert", "Alerts only")]

    var body: some View {
        Card(title: "Work log", symbol: "list.bullet.rectangle") {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Filter by tool or text", text: $model.filter)
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
                Picker("Level", selection: $model.levelFloor) {
                    ForEach(Self.levels, id: \.0) { Text($0.1).tag($0.0) }
                }
                .labelsHidden()
                .frame(width: 140)
                Button("Clear view") { model.clearView() }
                    .buttonStyle(.bordered)
                    .disabled(model.visibleEntries.isEmpty)
                if model.cleared {
                    Button("Show all") { model.showAll() }
                        .buttonStyle(.borderless)
                }
                Button {
                    model.saveLog()
                } label: {
                    Label("Save…", systemImage: "square.and.arrow.down")
                }
                .buttonStyle(.bordered)
            }
            ScrollViewReader { proxy in
                ScrollView([.horizontal, .vertical]) {
                    LazyVStack(alignment: .leading, spacing: 3) {
                        ForEach(model.visibleEntries) { entry in
                            LogLine(entry: entry) { artifact in
                                model.shownArtifact = artifact
                            }
                            .id(entry.id)
                            .onTapGesture { model.detailEntry = entry }
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .padding(.vertical, 4)
                }
                .overlay {
                    if model.visibleEntries.isEmpty {
                        Text("The log is empty.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
                .defaultScrollAnchor(UnitPoint(x: 0, y: 1), for: .initialOffset)
                .defaultScrollAnchor(UnitPoint(x: 0, y: 1), for: .sizeChanges)
                .onScrollGeometryChange(for: Bool.self) { geo in
                    geo.contentSize.height - geo.containerSize.height - geo.contentOffset.y < 24
                } action: { _, atBottom in
                    model.atBottom = atBottom
                    if atBottom { model.unseen = 0 }
                }
                .overlay(alignment: .bottom) {
                    if model.unseen > 0 && !model.atBottom {
                        Button {
                            if let last = model.visibleEntries.last {
                                withAnimation { proxy.scrollTo(last.id, anchor: UnitPoint(x: 0, y: 1)) }
                            }
                        } label: {
                            Label("New entries", systemImage: "arrow.down")
                                .font(.caption)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .padding(.bottom, 8)
                    }
                }
                .frame(height: 360)
                .background(Color(nsColor: .textBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
    }
}

/// One symbol per tool family, in one colour. A text glyph takes its place when the symbol is missing.
struct ToolIcon: View {
    let tool: String

    var body: some View {
        let spec = Self.spec(tool)
        Group {
            if NSImage(systemSymbolName: spec.symbol, accessibilityDescription: nil) != nil {
                Image(systemName: spec.symbol)
            } else {
                Text(spec.glyph)
            }
        }
        .foregroundStyle(.secondary)
        .frame(width: 16, alignment: .center)
    }

    static func spec(_ tool: String) -> (symbol: String, glyph: String) {
        if tool.hasPrefix("mac_") { return ("macwindow", "▣") }
        if tool.hasPrefix("chrome_") { return ("globe", "◎") }
        if tool.hasPrefix("telegram") || tool == "notify_user" { return ("paperplane", "➤") }
        if tool.hasPrefix("log_") { return ("text.bubble", "✎") }
        if tool.hasPrefix("audit") { return ("list.bullet", "≡") }
        if tool.hasPrefix("trust") { return ("clock", "◷") }
        if tool.hasPrefix("approval") { return ("hand.raised", "✋") }
        if tool == "bash" || tool == "sysinfo" { return ("terminal", ">") }
        if tool.hasSuffix("_process") || tool.hasSuffix("process_output") { return ("cpu", "▤") }
        if ["list_dir", "read_file", "write_file", "edit_file", "delete_path", "search_files", "file_get", "file_put"].contains(tool) {
            return ("doc", "▯")
        }
        if tool == "service" || tool == "tunnel" || tool == "step" { return ("gearshape", "⚙") }
        return ("circle", "•")
    }
}

struct LogLine: View {
    let entry: LogEntry
    let show: (Artifact) -> Void

    var body: some View {
        HStack(spacing: 8) {
            Text(entry.clock)
                .foregroundStyle(.secondary)
                .fixedSize()
            Circle()
                .fill(Self.levelColor(entry.level))
                .frame(width: 7, height: 7)
            ToolIcon(tool: entry.tool)
            Text(entry.tool)
                .frame(width: 150, alignment: .leading)
            Text(entry.status)
                .foregroundStyle(Self.statusColor(entry.status))
                .frame(width: 72, alignment: .leading)
            Text(entry.duration)
                .foregroundStyle(.secondary)
                .frame(width: 84, alignment: .trailing)
            Text(entry.source)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(width: 180, alignment: .leading)
            Text([entry.summary, entry.detail].filter { !$0.isEmpty }.joined(separator: "  — "))
                .foregroundStyle(.secondary)
                .fixedSize()
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
        .lineLimit(1)
        .fixedSize(horizontal: true, vertical: false)
        .font(.system(size: 11, design: .monospaced))
        .padding(.horizontal, 6)
        .contentShape(Rectangle())
    }

    static func levelColor(_ level: String) -> Color {
        switch level {
        case "alert": return .red
        case "warning": return .orange
        case "notice": return .blue
        default: return .secondary.opacity(0.5)
        }
    }

    static func statusColor(_ status: String) -> Color {
        switch status {
        case "ok", "opened", "started", "up", "step": return .green
        case "error", "exception", "unauthorized", "gave_up", "down": return .red
        default: return .orange
        }
    }
}

/// The full record of one entry, read from the bridge when the row is opened.
struct EntryDetail: View {
    let entry: LogEntry
    @Environment(\.dismiss) private var dismiss
    @State private var text = "Loading…"

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("\(entry.tool) · \(entry.status)")
                    .font(.headline)
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
            ScrollView([.horizontal, .vertical]) {
                Text(text)
                    .font(.system(size: 11, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            .background(Color(nsColor: .textBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        .padding(16)
        .frame(width: 640, height: 480)
        .task {
            let (code, body) = await Bridge().call("audit/entry", query: ["id": entry.id])
            if code == 200, let data = try? JSONSerialization.data(withJSONObject: body, options: [.prettyPrinted, .sortedKeys]) {
                text = String(decoding: data, as: UTF8.self)
            } else {
                text = "Could not load the record (\(code))."
            }
        }
    }
}

/// A screenshot or an accessibility tree, opened from the log.
struct ArtifactView: View {
    let artifact: Artifact
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var image: NSImage?
    @State private var elements: [AxElement] = []
    @State private var showRaw = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(artifact.name)
                    .font(.headline)
                Text(artifact.bytes > 0 ? "\(artifact.bytes) bytes" : "")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if !elements.isEmpty {
                    Picker("", selection: $showRaw) {
                        Text("Tree").tag(false)
                        Text("Raw").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 150)
                    .help("The accessibility tree or the raw answer of the tool")
                }
                Button("Close") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
            } else if !elements.isEmpty && !showRaw {
                List(elements) { element in
                    HStack(spacing: 8) {
                        Text(element.id)
                            .font(.system(size: 10, design: .monospaced))
                            .frame(width: 72, alignment: .leading)
                        Text(element.role)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .frame(width: 110, alignment: .leading)
                        Text(element.title)
                            .lineLimit(1)
                        Spacer()
                        Text(element.bounds)
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundStyle(.tertiary)
                    }
                }
                .font(.system(size: 11, design: .monospaced))
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
        .frame(width: 860, height: 620)
        .onAppear {
            if artifact.isImage {
                image = NSImage(contentsOfFile: artifact.path)
            }
            if let data = FileManager.default.contents(atPath: artifact.path) {
                text = String(data: data, encoding: .utf8) ?? ""
                elements = artifact.isTree ? AxElement.parse(data) : []
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

