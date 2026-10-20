import AppKit
import CryptoKit
import Foundation

/// Keeps the app current. A release announcement only says that something new exists;
/// the download, its checksum and its signature are taken from the official release.
@MainActor
final class Updater: ObservableObject {
    static let shared = Updater()
    static let repo = "vernikr/arena-bridge"
    static let topic = "vernikr-arena-bridge-releases"
    private static let automaticKey = "update.automatic"

    @Published var status = ""
    @Published var pending: Release?
    @Published var busy = false
    @Published var automatic: Bool = UserDefaults.standard.object(forKey: "update.automatic") as? Bool ?? true {
        didSet { UserDefaults.standard.set(automatic, forKey: Self.automaticKey) }
    }

    struct Release {
        let version: String
        let dmg: URL
        let sha256: String
    }

    enum UpdateError: LocalizedError {
        case noRelease, download, checksum, signature, version, cli

        var errorDescription: String? {
            switch self {
            case .noRelease: return "the release has no macOS app yet"
            case .download: return "the download failed"
            case .checksum: return "the download does not match the published checksum"
            case .signature: return "the new app is not signed with the same certificate, so it was not installed"
            case .version: return "the downloaded app has another version"
            case .cli: return "the bridge command line tool could not be updated"
            }
        }
    }

    nonisolated static var installedVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    private var tasks: [Task<Void, Never>] = []

    /// Checks shortly after launch, then every six hours, and whenever the release channel announces one.
    func start() {
        guard tasks.isEmpty else { return }
        tasks = [
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(60))
                while !Task.isCancelled {
                    await self?.check()
                    try? await Task.sleep(for: .seconds(6 * 3600))
                }
            },
            Task { [weak self] in
                while !Task.isCancelled {
                    await self?.listen()
                    try? await Task.sleep(for: .seconds(10))
                }
            },
        ]
    }

    private func listen() async {
        guard let url = URL(string: "https://ntfy.sh/\(Self.topic)/sse") else { return }
        do {
            let (bytes, response) = try await URLSession.shared.bytes(from: url)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return }
            for try await line in bytes.lines where line.hasPrefix("data:") {
                if let event = try? JSONDecoder().decode(NtfyEvent.self, from: Data(line.dropFirst(5).utf8)),
                   event.event == "message" {
                    await check()
                }
            }
        } catch {
            return
        }
    }

    private struct NtfyEvent: Decodable {
        let event: String
    }

    /// Looks at the latest official release and installs it when the mode allows.
    func check() async {
        guard !busy, let release = try? await Self.latestRelease() else { return }
        guard Self.isNewer(release.version, than: Self.installedVersion) else {
            if pending == nil { status = "Up to date (\(Self.installedVersion))" }
            return
        }
        guard pending?.version != release.version else { return }
        pending = release
        if automatic {
            await install(release)
        } else {
            status = "Version \(release.version) is ready to install."
        }
    }

    func install(_ release: Release) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            status = "Downloading \(release.version)…"
            let (downloaded, response) = try await URLSession.shared.download(from: release.dmg)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw UpdateError.download }
            status = "Checking \(release.version)…"
            let script = try await Task.detached { try Updater.stage(downloaded, release) }.value
            status = "Restarting with \(release.version)…"
            Updater.launch(script)
            NSApp.terminate(nil)
        } catch {
            status = "Update failed: \(error.localizedDescription)"
        }
    }

    nonisolated static func latestRelease() async throws -> Release {
        var request = URLRequest(url: URL(string: "https://api.github.com/repos/\(repo)/releases/latest")!)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 30
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tag = json["tag_name"] as? String,
              let assets = json["assets"] as? [[String: Any]] else { throw UpdateError.noRelease }
        let dmgName = "Arena-Bridge-\(arch).dmg"
        func url(_ name: String) -> URL? {
            (assets.first { $0["name"] as? String == name }?["browser_download_url"] as? String).flatMap { URL(string: $0) }
        }
        guard let dmg = url(dmgName), let sums = url("SHA256SUMS") else { throw UpdateError.noRelease }
        let (sumData, _) = try await URLSession.shared.data(from: sums)
        let text = String(decoding: sumData, as: UTF8.self)
        guard let line = text.split(separator: "\n").first(where: { $0.hasSuffix(dmgName) }),
              let hash = line.split(separator: " ").first else { throw UpdateError.noRelease }
        let version = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
        return Release(version: version, dmg: dmg, sha256: String(hash).lowercased())
    }

    /// Checks the download and writes the script that swaps the app once this process has quit.
    nonisolated static func stage(_ downloaded: URL, _ release: Release) throws -> URL {
        let fm = FileManager.default
        let work = fm.temporaryDirectory.appendingPathComponent("arena-update-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: work, withIntermediateDirectories: true)
        let dmg = work.appendingPathComponent("update.dmg")
        try fm.moveItem(at: downloaded, to: dmg)
        guard sha256(of: dmg) == release.sha256 else { throw UpdateError.checksum }

        let mount = work.appendingPathComponent("mount", isDirectory: true)
        try fm.createDirectory(at: mount, withIntermediateDirectories: true)
        _ = try run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-quiet", "-mountpoint", mount.path, dmg.path])
        defer { _ = try? run("/usr/bin/hdiutil", ["detach", "-quiet", mount.path]) }
        let app = work.appendingPathComponent("Arena Bridge.app", isDirectory: true)
        _ = try run("/usr/bin/ditto", [mount.appendingPathComponent("Arena Bridge.app").path, app.path])

        _ = try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path])
        let current = requirement(Bundle.main.bundleURL)
        guard !current.isEmpty, current == requirement(app) else { throw UpdateError.signature }
        let newVersion = Bundle(url: app)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        guard newVersion == release.version else { throw UpdateError.version }

        try updateCLI(to: release.version)

        let script = work.appendingPathComponent("apply.sh")
        try """
        #!/bin/sh
        while kill -0 "$1" 2>/dev/null; do sleep 0.5; done
        ditto "$3" "$2.new" && rm -rf "$2" && mv "$2.new" "$2"
        xattr -dr com.apple.quarantine "$2" 2>/dev/null
        launchctl kickstart -k "gui/$4/\(AppInfo.serviceLabel)" >/dev/null 2>&1
        open "$2"
        rm -rf "$5"
        """.write(to: script, atomically: true, encoding: .utf8)
        return script
    }

    /// Updates the command line tool that runs the bridge, then waits for the registry to show the version.
    nonisolated static func updateCLI(to version: String) throws {
        guard let cli = Bridge.cliPath() else { throw UpdateError.cli }
        for _ in 0..<20 {
            _ = try? runCLI(cli, ["update"])
            if let out = try? runCLI(cli, ["version"]), out.contains("installed: \(version)") { return }
            Thread.sleep(forTimeInterval: 30)
        }
        throw UpdateError.cli
    }

    nonisolated static func runCLI(_ cli: String, _ arguments: [String]) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: cli)
        process.arguments = arguments
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = searchPath
        process.environment = env
        return try capture(process)
    }

    /// Node and npm live in a version manager or Homebrew; an app started from Finder does not see them.
    nonisolated static var searchPath: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let fnm = "\(home)/.local/share/fnm/node-versions"
        let versions = ((try? FileManager.default.contentsOfDirectory(atPath: fnm)) ?? []).sorted().reversed()
        let dirs = versions.map { "\(fnm)/\($0)/installation/bin" } + ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]
        return (dirs + ["/usr/bin", "/bin"]).joined(separator: ":")
    }

    nonisolated static func launch(_ script: URL) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [
            script.path,
            "\(ProcessInfo.processInfo.processIdentifier)",
            Bundle.main.bundleURL.path,
            script.deletingLastPathComponent().appendingPathComponent("Arena Bridge.app").path,
            "\(getuid())",
            script.deletingLastPathComponent().path,
        ]
        try? process.run()
    }

    nonisolated static func requirement(_ app: URL) -> String {
        (try? run("/usr/bin/codesign", ["-d", "-r-", app.path]))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    nonisolated static func sha256(of file: URL) -> String {
        let data = (try? Data(contentsOf: file, options: .mappedIfSafe)) ?? Data()
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    @discardableResult
    nonisolated static func run(_ tool: String, _ arguments: [String]) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        return try capture(process)
    }

    nonisolated static func capture(_ process: Process) throws -> String {
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let text = String(data: data, encoding: .utf8) ?? ""
        guard process.terminationStatus == 0 else { throw NSError(domain: "Updater", code: Int(process.terminationStatus), userInfo: [NSLocalizedDescriptionKey: text]) }
        return text
    }

    nonisolated static var arch: String {
        #if arch(arm64)
        return "arm64"
        #else
        return "x86_64"
        #endif
    }

    nonisolated static func isNewer(_ candidate: String, than current: String) -> Bool {
        func parts(_ text: String) -> [Int] {
            text.trimmingCharacters(in: CharacterSet(charactersIn: "vV ")).split(separator: ".").map { Int($0) ?? 0 }
        }
        let a = parts(candidate), b = parts(current)
        for i in 0..<max(a.count, b.count) {
            let x = i < a.count ? a[i] : 0, y = i < b.count ? b[i] : 0
            if x != y { return x > y }
        }
        return false
    }
}
