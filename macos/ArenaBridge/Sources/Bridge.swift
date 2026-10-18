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

/// One line of the work log.
struct LogEntry: Identifiable {
    let id: String
    let time: Date
    let tool: String
    let status: String
    let duration: String
    let detail: String

    static func parse(_ raw: [String: Any]) -> LogEntry? {
        guard let id = raw["id"] as? String else { return nil }
        let formatter = ISO8601DateFormatter()
        let time = (raw["ts"] as? String).flatMap { formatter.date(from: $0) } ?? Date()
        let tool = raw["tool"] as? String ?? "?"
        let status = raw["status"] as? String ?? ""
        let ms = raw["duration_ms"] as? Int
        let duration = ms.map { "\($0) ms" } ?? ""
        var detail = raw["error"] as? String ?? ""
        if detail.isEmpty, let artifacts = raw["artifacts"] as? [[String: Any]], !artifacts.isEmpty {
            detail = artifacts.compactMap { $0["name"] as? String }.joined(separator: ", ")
        }
        return LogEntry(id: id, time: time, tool: tool, status: status, duration: duration, detail: detail)
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
              body: [String: Any]? = nil, local: Bool = false) async -> (Int, [String: Any]) {
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty {
            components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = components.url else { return (0, [:]) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 12
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
            if let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                payload = json
            }
            return (code, payload)
        } catch {
            return (0, [:])
        }
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
        _ = launchctl(["bootstrap", "gui/\(getuid())", plistPath])
        _ = launchctl(["kickstart", "-k", serviceTarget])
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
