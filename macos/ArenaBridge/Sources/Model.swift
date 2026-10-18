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

    private let bridge = Bridge()

    var visibleEntries: [LogEntry] {
        let needle = filter.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return entries }
        return entries.filter { $0.tool.lowercased().contains(needle) || $0.detail.lowercased().contains(needle) }
    }

    var pendingCount: Int { approvals.count }

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

        let audit = await bridge.call("audit", query: ["limit": "200"])
        entries = Array(((audit.1["entries"] as? [[String: Any]]) ?? []).compactMap(LogEntry.parse).reversed())
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

    func decide(_ approval: Approval, approve: Bool) {
        Task {
            let result = await bridge.call("approvals/\(approval.id)", method: "POST",
                                          body: ["decision": approve ? "approve" : "deny"], local: true)
        if result.0 == 200 {
            notice = approve ? "Approved \(approval.tool)." : "Denied \(approval.tool)."
            failure = nil
        } else {
            failure = (result.1["reason"] as? String) ?? "The decision was not accepted."
        }
            await refresh()
        }
    }

    /// Write the visible log to a file the user chooses.
    func saveLog() {
        let panel = NSSavePanel()
        panel.title = "Save the work log"
        panel.nameFieldStringValue = "arena-bridge-log-\(DateFormatter().string(from: Date(), pattern: "yyyy-MM-dd-HHmm")).txt"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        var text = "Arena Bridge — work log\n"
        text += "device: \(device)\nurl: \(url ?? "—")\ncreated: \(formatter.string(from: Date()))\n\n"
        for entry in visibleEntries {
            var line = "\(formatter.string(from: entry.time))  \(entry.tool)  \(entry.status)  \(entry.duration)"
            if !entry.detail.isEmpty { line += "  — \(entry.detail)" }
            text += line + "\n"
        }
        do {
            try text.write(to: url, atomically: true, encoding: .utf8)
            notice = "Saved: \(url.path)"
            failure = nil
        } catch {
            failure = error.localizedDescription
        }
    }

    func copyURL() {
        guard let url else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url, forType: .string)
        notice = "The address is copied."
    }
}
