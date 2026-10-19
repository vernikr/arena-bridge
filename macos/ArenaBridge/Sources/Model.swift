import Foundation
import SwiftUI
import AppKit
import Combine

/// Everything the window shows, and every action it can take.
@MainActor
final class AppModel: ObservableObject {
    @Published var running = false
    @Published var serviceInstalled = false
    @Published var version = "—"
    @Published var device = "—"
    @Published var mode = "—"
    @Published var url: String? = nil
    @Published var toolCount = 0
    @Published var telegramEnabled = false
    @Published var telegramChats: [String] = []
    @Published var approvals: [Approval] = []
    @Published var entries: [LogEntry] = []
    @Published var busy = false
    @Published var notice: String? = nil
    @Published var failure: String? = nil
    @Published var showSetup = false
    @Published var filter = "" { didSet { recompute() } }
    @Published var levelFloor = "info" { didSet { recompute() } }
    @Published private(set) var visibleEntries: [LogEntry] = []
    @Published private(set) var cleared = false
    @Published var atBottom = true
    @Published var unseen = 0
    @Published var detailEntry: LogEntry?
    @Published var operation: ServiceOp?
    var cancelRequested = false
    @Published var publicReady = false
    @Published var trustEnabled = false
    @Published var trustRemaining = 0
    @Published var trustTools: [String] = []
    @Published var shownArtifact: Artifact? = nil
    @Published var notificationsAllowed = false
    @Published var screenAccess: Bool? = nil
    @Published var accessibilityAccess: Bool? = nil
    @Published var permissionsChecking = false
    @Published var permissionsCheckedAt: Date? = nil
    private var focusObserver: AnyCancellable?

    /// True when the app is signed with a certificate, so macOS keeps its permissions across updates.
    static let hasCertificate: Bool = {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(Bundle.main.bundleURL as CFURL, [], &code) == errSecSuccess, let code else { return false }
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let dict = info as? [String: Any] else { return false }
        return dict[kSecCodeInfoCertificates as String] != nil
    }()

    /// Permissions that are known to be missing, in guide order.
    var missingPermissions: [PermissionKind] {
        [(PermissionKind.screen, screenAccess), (.accessibility, accessibilityAccess)]
            .compactMap { $0.1 == false ? $0.0 : nil }
    }

    /// Opens the guide for one permission in its own floating window.
    func openGuide(_ kind: PermissionKind) {
        GuideWindow.show(id: kind.rawValue, title: "\(kind.title) · Arena Bridge", size: NSSize(width: 640, height: 620)) {
            PermissionGuideView(kind: kind).environmentObject(self)
        }
        checkPermissions(force: true)
    }

    /// Opens the certificate guide in its own floating window.
    func openSigningGuide() {
        GuideWindow.show(id: "signing", title: "Keep permissions after updates · Arena Bridge", size: NSSize(width: 680, height: 700)) {
            SigningGuideView().environmentObject(self)
        }
    }

    /// Asks the running service which permissions its screen runtime has. Read-only; at most once a minute unless forced.
    func checkPermissions(force: Bool = false) {
        guard !permissionsChecking else { return }
        if !force, let at = permissionsCheckedAt, Date().timeIntervalSince(at) < 60 { return }
        permissionsChecking = true
        Task {
            let (code, json) = await bridge.call("call", method: "POST",
                                                 body: ["tool": "mac_permissions", "args": [String: Any]()], timeout: 40)
            let text = json["permissions"] as? String ?? ""
            screenAccess = code == 200 ? PermissionKind.granted("Screen Recording", in: text) : nil
            accessibilityAccess = code == 200 ? PermissionKind.granted("Accessibility", in: text) : nil
            permissionsCheckedAt = Date()
            permissionsChecking = false
            if screenAccess == true && accessibilityAccess == true {
                GuideWindow.close(PermissionKind.screen.rawValue)
                GuideWindow.close(PermissionKind.accessibility.rawValue)
            }
        }
    }

    private let bridge = Bridge()
    private var notified: Set<String> = []
    private var timer: AnyCancellable?
    private var eventTask: Task<Void, Never>?
    private var tick = 0
    private var knownIds = Set<String>()
    private var headCursor: String?
    private var clearMark: String?
    static let windowSize = 5000

    init() {
        timer = Timer.publish(every: 4, on: .main, in: .common)
            .autoconnect()
            .sink { [weak self] _ in Task { await self?.step() } }
        // Auto-open blanket trust window for 3h on launch per user request
        Task { await self.ensureTrustOnLaunch() }
        // Live events via SSE — falls back to polling if unavailable
        startEventStream()
        // Permissions are checked again whenever the window comes back to the front
        focusObserver = NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)
            .sink { [weak self] _ in self?.checkPermissions(force: true) }
    }

    /// SSE live stream from /v1/events ( approvals/audit delta ). Reconnects on drop.
    private func startEventStream() {
        eventTask?.cancel()
        eventTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let cfg = BridgeConfig.load()
                let urlStr = "http://\(cfg.host):\(cfg.port)/v1/events"
                guard let url = URL(string: urlStr) else {
                    try? await Task.sleep(nanoseconds: 8_000_000_000); continue
                }
                var req = URLRequest(url: url)
                req.timeoutInterval = 0 // keep open
                if let tok = cfg.token, !tok.isEmpty {
                    req.setValue("Bearer \(tok)", forHTTPHeaderField: "Authorization")
                } else if let lt = cfg.localToken, !lt.isEmpty {
                    req.setValue("Bearer \(lt)", forHTTPHeaderField: "Authorization")
                }
                req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                do {
                    let (bytes, response) = try await URLSession.shared.bytes(for: req)
                    if (response as? HTTPURLResponse)?.statusCode != 200 {
                        try? await Task.sleep(nanoseconds: 8_000_000_000); continue
                    }
                    for try await line in bytes.lines {
                        if Task.isCancelled { return }
                        let s = line.trimmingCharacters(in: .whitespaces)
                        if s.isEmpty || s.hasPrefix(":") { continue }
                        if s.hasPrefix("event:") {
                            // on approvals/audit/heartbeat → refresh lightweight
                            let ev = s.replacingOccurrences(of: "event:", with: "").trimmingCharacters(in: .whitespaces)
                            if ev == "approvals" || ev == "audit" || ev == "heartbeat" {
                                await self.refresh(log: ev == "audit", showBusy: false)
                            }
                        }
                    }
                } catch {
                    // reconnect after delay
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                }
            }
        }
    }

    /// Ensure a blanket 3h trust window exists on app launch (runs once).
    func ensureTrustOnLaunch() async {
        let trust = Bridge.trustStatus()
        if !trust.enabled {
            openTrust(hours: 3)
        }
    }

    /// The state of the window follows the machine: every few seconds, and the work log
    /// now and then because it is the heaviest part.
    func step() async {
        tick += 1
        await refresh(log: tick % 8 == 0, showBusy: false)
    }

    /// Reads only the records written since the last read. Starts over when the bridge says the cursor is gone.
    private func loadAudit() async {
        var query = ["limit": "500"]
        if let cursor = headCursor { query["after"] = cursor }
        let (code, body) = await bridge.call("audit", query: query)
        guard code == 200 else { return }
        if body["reset"] as? Bool == true {
            entries = []
            knownIds = []
        }
        let fresh = ((body["entries"] as? [[String: Any]]) ?? [])
            .compactMap(LogEntry.parse)
            .filter { knownIds.insert($0.id).inserted }
        headCursor = body["head"] as? String ?? headCursor
        guard !fresh.isEmpty else { return }
        entries.append(contentsOf: fresh)
        if entries.count > Self.windowSize {
            entries.removeFirst(entries.count - Self.windowSize)
            knownIds = Set(entries.map(\.id))
        }
        if !atBottom { unseen += fresh.count }
        recompute()
    }

    /// Rebuilds the visible rows when the data, the level or the text filter changes.
    private func recompute() {
        var rows = entries[...]
        if clearMark != nil, let index = entries.lastIndex(where: { $0.id == clearMark }) {
            rows = entries[(index + 1)...]
        }
        let needle = filter.trimmingCharacters(in: .whitespaces).lowercased()
        let floor = LogEntry.rank(levelFloor)
        visibleEntries = rows.filter {
            LogEntry.rank($0.level) >= floor && (needle.isEmpty || $0.search.contains(needle))
        }
        cleared = clearMark != nil
    }

    /// Hides the rows shown so far. Only the view changes; the records stay in the audit log.
    func clearView() {
        clearMark = entries.last?.id
        recompute()
    }

    func showAll() {
        clearMark = nil
        recompute()
    }

    var pendingCount: Int { approvals.count }

    /// How long the trust window still lasts, as h:mm.
    var trustRemainingText: String {
        String(format: "%d:%02d", trustRemaining / 3600, (trustRemaining % 3600) / 60)
    }

    // -- reading -------------------------------------------------------- //

    func refresh(log: Bool = true, showBusy: Bool = true) async {
        if showBusy { busy = true }
        defer { if showBusy { busy = false } }
        checkPermissions()
        let service = Bridge.serviceState()
        serviceInstalled = service.installed
        running = service.running

        let health = await bridge.call("health")
        if health.0 == 200 {
            version = health.1["version"] as? String ?? "—"
            device = health.1["device"] as? String ?? "—"
            mode = health.1["mode"] as? String ?? "—"
            publicReady = health.1["has_public_url"] as? Bool ?? false
            running = true
        }

        let config = bridge.config
        url = config.publicUrl
        telegramEnabled = config.telegramEnabled
        telegramChats = config.telegramChats

        let tools = await bridge.call("tools")
        if tools.0 == 200 {
            toolCount = (tools.1["tools"] as? [[String: Any]])?.count ?? 0
        }

        let list = await bridge.call("approvals")
        approvals = ((list.1["approvals"] as? [[String: Any]]) ?? [])
            .filter { ($0["status"] as? String) == "pending" }
            .compactMap(Approval.parse)
            .sorted { $0.created > $1.created }
        announceApprovals()

        if log {
            await loadAudit()
        }

        notificationsAllowed = await Notifier.shared.allowed()

        let trust = Bridge.trustStatus()
        trustEnabled = trust.enabled
        trustRemaining = trust.remainingSec
        trustTools = trust.tools
    }

    /// Tell the user that the agent is waiting for a decision.
    private func announceApprovals() {
        for approval in approvals where !notified.contains(approval.id) {
            notified.insert(approval.id)
            Notifier.shared.post(title: "Approval needed", body: "\(approval.tool) is waiting for your decision.")
        }
    }

    // -- actions -------------------------------------------------------- //

    /// Start and stop run as numbered steps. The toggle, the indicator and the app menu read this one state.
    struct ServiceOp: Equatable {
        let starting: Bool
        var step: Int
        var total: Int
        var name: String
        var reason: String?
        var since = Date()
    }

    var transitioning: Bool { operation.map { $0.reason == nil } ?? false }

    func toggleService() {
        if running { stop() } else { start() }
    }

    func start() {
        guard !transitioning, !running else { return }
        Task {
            await run(starting: true, [
                ("Checking setup", checkSetup),
                ("Stopping old process", stopOld),
                ("Loading service", { await self.blocking("launchctl did not answer in 10 s") { Bridge.load() } }),
                ("Starting process", { await self.blocking("launchctl did not answer in 10 s") { Bridge.kick() } }),
                ("Waiting for the local API", { await self.waitFor(15) { await self.flag("ok") } ? nil : "local API did not answer in 15 s" }),
                ("Waiting for the public address", { await self.waitFor(30) { await self.flag("has_public_url") } ? nil : "public address not ready in 30 s" }),
                ("Checking tools", { await self.waitFor(5) { await self.toolCount() > 0 } ? nil : "no tools reported in 5 s" }),
            ])
        }
    }

    func stop() {
        guard !transitioning, running else { return }
        Task {
            await run(starting: false, [
                ("Checking open work", { await self.note("\(self.approvals.count) approvals pending"); return nil }),
                ("Stopping bridge", { await Task.detached { Bridge.stop() }.value; return nil }),
                ("Waiting for the public address to close", { await self.waitFor(10) { await Task.detached { !Bridge.tunnelRunning() }.value } ? nil : "public address still open after 10 s" }),
                ("Confirming stopped", { await Task.detached { !Bridge.serviceState().running }.value ? nil : "service still running" }),
            ])
        }
    }

    /// Lets the user cancel a start. Only a start can be cancelled; a stop always finishes.
    func cancelStart() {
        guard let op = operation, op.starting, op.reason == nil else { return }
        cancelRequested = true
    }

    private func run(starting: Bool, _ steps: [(String, () async -> String?)]) async {
        cancelRequested = false
        operation = ServiceOp(starting: starting, step: 0, total: steps.count, name: "", reason: nil)
        for (index, step) in steps.enumerated() {
            if cancelRequested {
                await cancelled(at: index)
                return
            }
            operation?.step = index + 1
            operation?.name = step.0
            operation?.since = Date()
            await note("\(index + 1)/\(steps.count) \(step.0)")
            if let reason = await step.1() {
                if cancelRequested {
                    await cancelled(at: index + 1)
                    return
                }
                operation?.reason = reason
                await note("failed at step \(index + 1)/\(steps.count): \(reason)", level: "alert")
                await refresh(log: false, showBusy: false)
                return
            }
        }
        operation = nil
        notice = starting ? "The bridge is running." : "The bridge is stopped."
        await refresh()
    }

    private func cancelled(at step: Int) async {
        cancelRequested = false
        await Task.detached { Bridge.stop() }.value
        operation = nil
        notice = "Start cancelled at step \(step). The bridge is stopped."
        await note("start cancelled by the user at step \(step)", level: "alert")
        await refresh()
    }

    private func blocking(_ reason: String, _ work: @escaping @Sendable () -> Bool) async -> String? {
        await Task.detached { work() }.value ? nil : reason
    }

    private func stopOld() async -> String? {
        guard await Task.detached { Bridge.serviceState().running }.value else { return nil }
        await Task.detached { Bridge.stop() }.value
        let gone = await waitFor(10) { await Task.detached { !Bridge.serviceState().running }.value }
        return gone ? nil : "old process still running after 10 s"
    }

    private func checkSetup() async -> String? {
        let installed = await Task.detached { Bridge.serviceState().installed }.value
        return installed ? nil : "run Setup first"
    }

    private func health() async -> [String: Any]? {
        let result = await bridge.call("health")
        return result.0 == 200 ? result.1 : nil
    }

    private func flag(_ key: String) async -> Bool {
        (await health()?[key] as? Bool) == true
    }

    private func toolCount() async -> Int {
        let result = await bridge.call("tools")
        return (result.1["tools"] as? [[String: Any]])?.count ?? 0
    }

    /// Writes one step line to the work log. When the bridge is down, the line stays in the app's own log.
    private func note(_ text: String, level: String = "info") async {
        let (code, _) = await bridge.call("log/event", method: "POST", body: ["kind": "step", "tool": "service", "status": "step", "level": level, "message": text])
        guard code != 200, let entry = LogEntry.parse(["id": "local-\(UUID().uuidString)", "tool": "service", "status": "step", "level": level, "args_preview": text]) else { return }
        entries.append(entry)
        recompute()
    }

    private func waitFor(_ seconds: Double, _ check: () async -> Bool) async -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end, !cancelRequested {
            if await check() { return true }
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
        return await check()
    }

    func decide(_ approval: Approval, approve: Bool, trustHours: Int = 0) {
        Task {
            let result = await bridge.call("approvals/\(approval.id)", method: "POST",
                                          body: ["decision": approve ? "approve" : "deny"], local: true)
            if result.0 == 200 {
                if approve && trustHours > 0 {
                    // blanket for all tools / any agent per user request
                    openTrust(hours: trustHours)
                    notice = "Approved \(approval.tool) — trusted for \(trustHours) h (all tools)."
                } else {
                    notice = approve ? "Approved \(approval.tool)." : "Denied \(approval.tool)."
                }
                failure = nil
            } else {
                failure = (result.1["reason"] as? String) ?? "The decision was not accepted."
            }
            await refresh()
        }
    }

    /// Let the agent act without asking — blanket (all tools, any agent).
    func openTrust(hours: Int = 3) {
        let until = Date().timeIntervalSince1970 * 1000 + Double(hours) * 3600 * 1000
        let now = Date().timeIntervalSince1970 * 1000
        let dict: [String: Any] = ["enabled": true, "until": until, "tools": [], "paths": [], "createdAt": now]
        let url = BridgeConfig.home.appendingPathComponent("trust.json")
        do {
            try FileManager.default.createDirectory(at: BridgeConfig.home, withIntermediateDirectories: true, attributes: [FileAttributeKey.posixPermissions: 0o700])
            let data = try JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: url, options: .atomic)
            try? FileManager.default.setAttributes([FileAttributeKey.posixPermissions: 0o600], ofItemAtPath: url.path)
            notice = "The agent can act freely for \(hours) h."
            failure = nil
        } catch {
            failure = error.localizedDescription
        }
        Task { await refresh() }
    }

    func closeTrust() {
        let url = BridgeConfig.home.appendingPathComponent("trust.json")
        do {
            if FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.removeItem(at: url)
            }
            notice = "The trust window is closed."
            failure = nil
        } catch {
            failure = error.localizedDescription
        }
        Task { await refresh() }
    }

    /// Put the prompt for the agent on the clipboard.
    func copyPrompt() {
        Task {
            let result = await bridge.callText("prompt")
            if result.0 == 200, !result.1.isEmpty {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(result.1, forType: .string)
                notice = "The agent prompt is copied."
                failure = nil
            } else {
                failure = "The prompt is not available."
            }
        }
    }

    /// Write the visible log to a file the user chooses.
    func saveLog() {
        let panel = NSSavePanel()
        panel.title = "Save the work log"
        let stamp = DateFormatter()
        stamp.dateFormat = "yyyy-MM-dd-HHmm"
        panel.nameFieldStringValue = "arena-bridge-log-\(stamp.string(from: Date())).txt"
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        var text = "\(AppInfo.name) — work log\n"
        text += "device: \(device)\nurl: \(url ?? "—")\ncreated: \(formatter.string(from: Date()))\n\n"
        var pictures: [Artifact] = []
        for entry in visibleEntries {
            var line = "\(formatter.string(from: entry.time))  \(entry.tool)  \(entry.status)  \(entry.duration)"
            if !entry.detail.isEmpty { line += "  — \(entry.detail)" }
            text += line + "\n"
            if !entry.summary.isEmpty {
                text += "    $ \(entry.summary)\n"
            }
            for artifact in entry.artifacts {
                if artifact.isTree, let tree = prettyJSON(at: artifact.path) {
                    text += "    \(artifact.name):\n"
                    text += tree.split(separator: "\n", omittingEmptySubsequences: false)
                        .map { "      \($0)" }.joined(separator: "\n") + "\n"
                }
                if artifact.isImage { pictures.append(artifact) }
            }
        }
        do {
            try text.write(to: destination, atomically: true, encoding: .utf8)
            let folder = destination.deletingLastPathComponent()
                .appendingPathComponent(destination.deletingPathExtension().lastPathComponent + "-artifacts")
            if !pictures.isEmpty {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                for picture in pictures {
                    let target = folder.appendingPathComponent(picture.name)
                    if FileManager.default.fileExists(atPath: target.path) { continue }
                    let stem = picture.name.replacingOccurrences(of: ".", with: "-")
                    let stamped = folder.appendingPathComponent("\(picture.entry)-\(stem)")
                    try? FileManager.default.copyItem(atPath: picture.path, toPath: stamped.path)
                }
            }
            notice = "Saved: \(destination.path)"
            failure = nil
        } catch {
            failure = error.localizedDescription
        }
    }

    /// Read a JSON file and lay it out for reading.
    private func prettyJSON(at path: String) -> String? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted]),
              let text = String(data: pretty, encoding: .utf8)
        else { return String(data: data, encoding: .utf8) }
        return text
    }

    func copyURL() {
        guard let url else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url, forType: .string)
        notice = "The address is copied."
    }

    deinit { eventTask?.cancel() }
}

/// One macOS permission the bridge needs, with the guide text for it.
enum PermissionKind: String, Identifiable {
    case screen, accessibility

    var id: String { rawValue }
    var title: String { self == .screen ? "Screen Recording" : "Accessibility" }
    var pane: String { self == .screen ? "Privacy_ScreenCapture" : "Privacy_Accessibility" }
    var paneName: String { self == .screen ? "Screen & System Audio Recording" : "Accessibility" }
    var consequence: String { self == .screen ? "screenshots and clicks will fail" : "element trees will be empty" }

    var steps: [String] {
        [
            "Click \"Open \(title) settings\" below. System Settings opens at Privacy & Security → \(paneName).",
            "Click + under the list. If + is grey, click the lock at the bottom left and enter your Mac password.",
            "Press ⌘⇧G, paste the path (click it or the copy icon above to copy it), press Return, then click Open.",
            "Switch on arena-bridge-agent. The Arena Bridge entry can stay in the list; it does no harm.",
            "If macOS asks you to quit Arena Bridge, click Later. Do not click Quit & Reopen yet.",
            "When this permission is done, quit Arena Bridge with ⌘Q, open it again, then click Check again.",
        ]
    }

    /// Reads one line such as "Screen Recording (Required): Not Granted" from the permission text.
    static func granted(_ label: String, in text: String) -> Bool? {
        guard let line = text.components(separatedBy: "\n").first(where: { $0.hasPrefix(label) }) else { return nil }
        return !line.contains("Not Granted")
    }
}
