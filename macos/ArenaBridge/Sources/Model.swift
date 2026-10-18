import Foundation
import SwiftUI
import AppKit

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
    @Published var filter = ""
    @Published var trustEnabled = false
    @Published var trustRemaining = 0
    @Published var trustTools: [String] = []
    @Published var shownArtifact: Artifact? = nil

    private let bridge = Bridge()
    private var notified: Set<String> = []

    var visibleEntries: [LogEntry] {
        let needle = filter.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return entries }
        return entries.filter {
            $0.tool.lowercased().contains(needle)
                || $0.detail.lowercased().contains(needle)
                || $0.summary.lowercased().contains(needle)
        }
    }

    var pendingCount: Int { approvals.count }

    /// How long the trust window still lasts, as h:mm.
    var trustRemainingText: String {
        String(format: "%d:%02d", trustRemaining / 3600, (trustRemaining % 3600) / 60)
    }

    // -- reading -------------------------------------------------------- //

    func refresh() async {
        busy = true
        defer { busy = false }
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

        let audit = await bridge.call("audit", query: ["limit": "120"])
        entries = Array(((audit.1["entries"] as? [[String: Any]]) ?? []).compactMap(LogEntry.parse).reversed())

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
        defer { busy = false }
        Bridge.start()
        notice = "The bridge was started."
        failure = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { Task { await self.refresh() } }
    }

    func stop() {
        busy = true
        defer { busy = false }
        Bridge.stop()
        notice = "The bridge was stopped."
        failure = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { Task { await self.refresh() } }
    }

    func decide(_ approval: Approval, approve: Bool, trustHours: Int = 0) {
        Task {
            let result = await bridge.call("approvals/\(approval.id)", method: "POST",
                                          body: ["decision": approve ? "approve" : "deny"], local: true)
            if result.0 == 200 {
                if approve && trustHours > 0 {
                    openTrust(hours: trustHours, tools: [approval.tool])
                    notice = "Approved \(approval.tool) — trusted for \(trustHours) h."
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

    /// Let the agent act without asking for a while.
    func openTrust(hours: Int = 3, tools: [String] = []) {
        var arguments = ["trust", "--for", "\(hours)h"]
        if !tools.isEmpty { arguments += ["--tools", tools.joined(separator: ",")] }
        let result = Bridge.run(arguments)
        if result.code == 0 {
            notice = tools.isEmpty
                ? "The agent can act freely for \(hours) h."
                : "\(tools.joined(separator: ", ")) can act freely for \(hours) h."
            failure = nil
        } else {
            failure = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        Task { await refresh() }
    }

    func closeTrust() {
        let result = Bridge.run(["trust", "--off"])
        if result.code == 0 {
            notice = "The trust window is closed."
            failure = nil
        } else {
            failure = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
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
        var text = "Arena Bridge — work log\n"
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
                    if !FileManager.default.fileExists(atPath: target.path) {
                        try FileManager.default.copyItem(atPath: picture.path, toPath: target.path)
                    }
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
}
