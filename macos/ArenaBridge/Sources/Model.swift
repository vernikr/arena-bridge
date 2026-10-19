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
    @Published var trustEnabled = false
    @Published var trustRemaining = 0
    @Published var trustTools: [String] = []
    @Published var shownArtifact: Artifact? = nil
    @Published var notificationsAllowed = false

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
        let service = Bridge.serviceState()
        serviceInstalled = service.installed
        running = service.running

        let health = await bridge.call("health")
        if health.0 == 200 {
            version = health.1["version"] as? String ?? "—"
            device = health.1["device"] as? String ?? "—"
            mode = health.1["mode"] as? String ?? "—"
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

    func start() {
        busy = true
        Task.detached {
            Bridge.start()
            await MainActor.run {
                self.notice = "The bridge was started."
                self.failure = nil
                self.busy = false
                Task { await self.refresh() }
            }
        }
    }

    func stop() {
        busy = true
        Task.detached {
            Bridge.stop()
            await MainActor.run {
                self.notice = "The bridge was stopped."
                self.failure = nil
                self.busy = false
                Task { await self.refresh() }
            }
        }
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
