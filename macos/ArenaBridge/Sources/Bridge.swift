import Foundation

/// The bridge configuration, read from ~/.arena-bridge/config.json.
struct BridgeConfig {
    var mode = "direct"
    var host = "127.0.0.1"
    var port = 8787
    var publicUrl: String? = nil
    var token: String? = nil
    var localToken: String? = nil
    var device: String? = nil
    var roots: [String] = []
    var requireApproval = true
    var telegramEnabled = false
    var telegramChats: [String] = []
    var installed = false

    static var home: URL {
        let env = ProcessInfo.processInfo.environment["ARENA_BRIDGE_HOME"]
        if let env, !env.isEmpty { return URL(fileURLWithPath: env) }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".arena-bridge")
    }

    static var configURL: URL { home.appendingPathComponent("config.json") }

    static func load() -> BridgeConfig {
        var cfg = BridgeConfig()
        guard let data = try? Data(contentsOf: configURL),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return cfg }
        cfg.mode = raw["mode"] as? String ?? cfg.mode
        cfg.host = raw["host"] as? String ?? cfg.host
        cfg.port = raw["port"] as? Int ?? cfg.port
        cfg.publicUrl = raw["publicUrl"] as? String
        if cfg.publicUrl == nil, let state = try? Data(contentsOf: home.appendingPathComponent("state.json")),
           let stateRaw = try? JSONSerialization.jsonObject(with: state) as? [String: Any] {
            cfg.publicUrl = stateRaw["publicUrl"] as? String
        }
        cfg.token = raw["token"] as? String
        cfg.localToken = raw["localToken"] as? String
        cfg.device = raw["device"] as? String
        cfg.roots = raw["roots"] as? [String] ?? []
        cfg.requireApproval = raw["requireApproval"] as? Bool ?? cfg.requireApproval
        if let tg = raw["telegram"] as? [String: Any] {
            cfg.telegramEnabled = tg["enabled"] as? Bool ?? false
            cfg.telegramChats = tg["chatIds"] as? [String] ?? []
        }
        cfg.installed = FileManager.default.fileExists(
            atPath: FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/LaunchAgents/ai.arena.bridge.plist").path)
        return cfg
    }
}

/// A pending approval request.
struct Approval: Identifiable {
    let id: String
    let tool: String
    let summary: String
    let created: Date

    static func parse(_ raw: [String: Any]) -> Approval? {
        guard let id = raw["id"] as? String, let tool = raw["tool"] as? String else { return nil }
        var summary = ""
        if let args = raw["args"] as? [String: Any] {
            if let command = args["command"] as? String {
                summary = command.count > 120 ? String(command.prefix(120)) + "…" : command
            } else if !args.isEmpty {
                summary = args.map { "\($0.key): \($0.value)" }.joined(separator: ", ")
                if summary.count > 120 { summary = String(summary.prefix(120)) + "…" }
            }
        }
        let created = Date(timeIntervalSince1970: (raw["createdAt"] as? Double ?? 0) / 1000)
        return Approval(id: id, tool: tool, summary: summary, created: created)
    }
}

/// A file the audit log kept as evidence.
struct Artifact: Identifiable {
    let id: String
    let entry: String
    let name: String
    let kind: String
    let path: String
    let bytes: Int

    var isImage: Bool { name.hasSuffix(".png") || name.hasSuffix(".jpg") || name.hasSuffix(".jpeg") }
    var isTree: Bool { name.hasSuffix(".json") }

    static func parse(_ raw: [String: Any], entry: String = "") -> Artifact? {
        guard let name = raw["name"] as? String else { return nil }
        return Artifact(
            id: name,
            entry: entry,
            name: name,
            kind: raw["kind"] as? String ?? "",
            path: raw["path"] as? String ?? "",
            bytes: raw["bytes"] as? Int ?? 0
        )
    }
}

/// One element of an accessibility tree.
struct AxElement: Identifiable {
    let id: String
    let role: String
    let title: String
    let bounds: String

    /// Read the elements out of a Peekaboo payload.
    static func parse(_ data: Data) -> [AxElement] {
        guard let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }
        let payload = (raw["data"] as? [String: Any]) ?? raw
        let list = (payload["ui_elements"] as? [[String: Any]]) ?? []
        return list.compactMap { item in
            guard let identifier = item["id"] as? String else { return nil }
            let role = (item["ax_role"] as? String) ?? (item["role"] as? String) ?? ""
            let title = (item["title"] as? String) ?? (item["label"] as? String) ?? (item["description"] as? String) ?? ""
            var frame = ""
            if let bounds = item["bounds"] as? [String: Any] {
                let x = bounds["x"] as? Int ?? 0
                let y = bounds["y"] as? Int ?? 0
                let w = bounds["width"] as? Int ?? 0
                let h = bounds["height"] as? Int ?? 0
                frame = "\(x),\(y) \(w)×\(h)"
            }
            return AxElement(id: identifier, role: role, title: title, bounds: frame)
        }
    }
}

/// One line of the work log.
struct LogEntry: Identifiable {
    let id: String
    let time: Date
    let clock: String
    let level: String
    let tool: String
    let status: String
    let duration: String
    let detail: String
    let summary: String
    let source: String
    let artifacts: [Artifact]
    let search: String

    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let iso = ISO8601DateFormatter()
    private static let clockFormat: DateFormatter = {
        let f = DateFormatter()
        f.locale = .current
        let hour12 = (DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: .current) ?? "").contains("a")
        f.dateFormat = hour12 ? "hh:mm:ss a" : "HH:mm:ss"
        return f
    }()

    static func parseDate(_ text: String?) -> Date? {
        guard let text else { return nil }
        return isoFractional.date(from: text) ?? iso.date(from: text)
    }

    private static let grouping: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.locale = .current
        return f
    }()

    static func rank(_ level: String) -> Int {
        switch level {
        case "notice": return 1
        case "warning": return 2
        case "alert": return 3
        default: return 0
        }
    }

    static func parse(_ raw: [String: Any]) -> LogEntry? {
        guard let id = raw["id"] as? String else { return nil }
        let time = parseDate(raw["ts"] as? String) ?? Date()
        clockFormat.timeZone = .current
        let tool = raw["tool"] as? String ?? raw["kind"] as? String ?? "?"
        let status = raw["status"] as? String ?? ""
        let ms = raw["duration_ms"] as? Int
        let duration = ms.map { (grouping.string(from: NSNumber(value: $0)) ?? "\($0)") + " ms" } ?? ""
        var detail = raw["error"] as? String ?? ""
        let artifacts = (raw["artifacts"] as? [[String: Any]] ?? []).compactMap { Artifact.parse($0, entry: id) }
        if detail.isEmpty, !artifacts.isEmpty {
            detail = artifacts.map(\.name).joined(separator: ", ")
        }
        let summary = (raw["args"] as? [String: Any]).map(summarize) ?? previewText(raw["args_preview"] as? String ?? "")
        return LogEntry(
            id: id,
            time: time,
            clock: clockFormat.string(from: time),
            level: raw["level"] as? String ?? "info",
            tool: tool,
            status: status,
            duration: duration,
            detail: detail,
            summary: summary,
            source: sourceText(raw["source"] as? [String: Any]),
            artifacts: artifacts,
            search: [tool, detail, summary].joined(separator: " ").lowercased()
        )
    }

    /// The reverse-DNS name when known, otherwise the address, otherwise the channel.
    static func sourceText(_ source: [String: Any]?) -> String {
        guard let source else { return "" }
        let host = source["host"] as? String ?? ""
        let ip = source["ip"] as? String ?? ""
        if !host.isEmpty { return host }
        if !ip.isEmpty { return ip }
        return source["channel"] as? String ?? ""
    }

    /// The list sends the start of the parameters as text; show the command without the JSON around it.
    static func previewText(_ preview: String) -> String {
        var text = preview
        if text.hasPrefix("{\"command\":\"") { text = String(text.dropFirst(12)) }
        if text.hasSuffix("\"}") { text = String(text.dropLast(2)) }
        text = text.replacingOccurrences(of: "\\n", with: " ")
        return text.count > 160 ? String(text.prefix(160)) + "…" : text
    }

    /// A one line description of what the call actually asked for.
    static func summarize(_ args: [String: Any]) -> String {
        if let command = args["command"] as? String { return command }
        let interesting = ["url", "path", "app", "window", "text", "selector", "query", "mode", "profile", "element"]
        var parts: [String] = []
        for key in interesting {
            if let value = args[key] { parts.append("\(key)=\(value)") }
        }
        if parts.isEmpty {
            for (key, value) in args.sorted(by: { $0.key < $1.key }) {
                parts.append("\(key)=\(value)")
            }
        }
        let joined = parts.joined(separator: "  ")
        return joined.count > 160 ? String(joined.prefix(160)) + "…" : joined
    }
}

/// Thin client for the local bridge API and the macOS service.
struct Bridge {
    static let serviceLabel = "ai.arena.bridge"

    var config: BridgeConfig { BridgeConfig.load() }

    var baseURL: URL {
        URL(string: "http://\(config.host):\(config.port)")!
    }

    /// One API call. Returns the status code and the decoded JSON body.
    func call(_ path: String, query: [String: String] = [:], method: String = "GET",
              body: [String: Any]? = nil, timeout: TimeInterval = 12, local: Bool = false) async -> (Int, [String: Any]) {
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty {
            components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = components.url else { return (0, [:]) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        let token = local ? config.localToken : config.token
        if let token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            var payload: [String: Any] = [:]
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                payload = json
            }
            return (code, payload)
        } catch {
            return (0, [:])
        }
    }

    /// One API call that returns plain text.
    func callText(_ path: String) async -> (Int, String) {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.timeoutInterval = 12
        if let token = config.token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            return (code, String(data: data, encoding: .utf8) ?? "")
        } catch {
            return (0, "")
        }
    }

    /// The trust window state, read from ~/.arena-bridge/trust.json.
    static func trustStatus() -> (enabled: Bool, remainingSec: Int, tools: [String]) {
        let url = BridgeConfig.home.appendingPathComponent("trust.json")
        if let data = try? Data(contentsOf: url),
           let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let until = (raw["until"] as? Double) ?? 0
            let left = Int(max(0, until - Date().timeIntervalSince1970 * 1000) / 1000)
            let enabled = (raw["enabled"] as? Bool ?? true) && left > 0
            return (enabled, left, raw["tools"] as? [String] ?? [])
        }
        let result = run(["trust", "--status", "--json"])
        guard result.code == 0,
              let data = result.output.data(using: .utf8),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return (false, 0, []) }
        return (
            raw["enabled"] as? Bool ?? false,
            raw["remaining_sec"] as? Int ?? 0,
            raw["tools"] as? [String] ?? []
        )
    }

    /// The path of the bridge command line tool.
    static func cliPath() -> String? {
        var candidates = [
            FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin/arena-bridge").path,
            "/opt/homebrew/bin/arena-bridge",
            "/usr/local/bin/arena-bridge",
            "/usr/bin/arena-bridge",
        ]
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            candidates += path.split(separator: ":").map { "\($0)/arena-bridge" }
        }
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// Run the bridge command line tool.
    @discardableResult
    static func run(_ arguments: [String]) -> (code: Int32, output: String) {
        guard let cli = cliPath() else { return (127, "arena-bridge not found") }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: cli)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
        } catch {
            return (127, error.localizedDescription)
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    }

    // -- the macOS background service ---------------------------------- //

    static var serviceTarget: String { "gui/\(getuid())/\(serviceLabel)" }

    static var plistPath: String {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(serviceLabel).plist").path
    }

    /// Is the service installed and running?
    static func serviceState() -> (installed: Bool, running: Bool) {
        let installed = FileManager.default.fileExists(atPath: plistPath)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["print", serviceTarget]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
        } catch {
            return (installed, false)
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let text = String(data: data, encoding: .utf8) ?? ""
        return (installed, text.contains("state = running"))
    }

    static func start() {
        load()
        kick()
    }

    static func load() { _ = launchctl(["bootstrap", "gui/\(getuid())", plistPath]) }

    static func kick() { _ = launchctl(["kickstart", "-k", serviceTarget]) }

    /// True while a cloudflared process is alive; used to confirm the public address closed.
    static func tunnelRunning() -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        process.arguments = ["-f", "cloudflared"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return false }
        process.waitUntilExit()
        return process.terminationStatus == 0
    }

    static func stop() {
        _ = launchctl(["bootout", serviceTarget])
    }

    @discardableResult
    static func launchctl(_ arguments: [String]) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try? process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }
}
